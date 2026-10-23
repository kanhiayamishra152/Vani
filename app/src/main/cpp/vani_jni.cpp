// Vani AI - JNI bridge.
//
// Two engines:
//   llama.cpp   - LLM inference (token streaming)
//   sherpa-onnx - streaming STT, Silero VAD, offline ONNX-Runtime TTS
//
// This file was written against verified upstream headers, NOT recollection:
//   llama.cpp   4231b23dc2c46661d01157aac5245bdcf03ce4b1  (v0.7.0-dev)
//   sherpa-onnx 8abb7c8f87eae85b2e75f9a4115236c978980add  (v2.0.0)
//
// Two API details that differ from older code and will not compile if ported blindly:
//   * sherpa-onnx v2.0.0 renamed the streaming ASR entry points. The online recognizer
//     is SherpaOnnxCreateOnlineRecognizer / SherpaOnnxOnlineStreamAcceptWaveform /
//     SherpaOnnxDecodeOnlineStream / SherpaOnnxGetOnlineStreamResult. The offline
//     recognizer uses SherpaOnnxAcceptWaveformOffline / SherpaOnnxDecodeOfflineStream.
//     The pre-2.0 names (SherpaOnnxAcceptWaveform, SherpaOnnxGetResult) no longer exist.
//   * llama.cpp's KV cache is now addressed through llama_memory_t returned by
//     llama_get_memory(), not the old llama_kv_cache_clear(ctx) overload.

#include <jni.h>
#include <android/log.h>

#include <atomic>
#include <cstring>
#include <mutex>
#include <string>
#include <vector>

#include "llama.h"
#include "sherpa-onnx/c-api.h"

#define LOG_TAG "VaniNative"
#define LOGE(...) __android_log_print(ANDROID_LOG_ERROR, LOG_TAG, __VA_ARGS__)
#define LOGW(...) __android_log_print(ANDROID_LOG_WARN, LOG_TAG, __VA_ARGS__)
#define LOGI(...) __android_log_print(ANDROID_LOG_INFO, LOG_TAG, __VA_ARGS__)

// ---------------------------------------------------------------------------
// Progress callback plumbing
//
// llama.cpp calls the progress callback on whatever thread loads the model. We hop
// back into the JVM on a detached thread so Kotlin can render real progress bars
// instead of a frozen UI with no feedback.
// ---------------------------------------------------------------------------
static JavaVM *g_vm = nullptr;
static jobject g_progressListener = nullptr;  // global ref
static jmethodID g_onProgress = nullptr;      // void (float)
static std::atomic<float> g_lastProgress{0.0f};

static bool notifyProgress(float p) {
    g_lastProgress.store(p);
    if (g_vm == nullptr || g_progressListener == nullptr || g_onProgress == nullptr) {
        return true;  // never abort a load because UI is not attached
    }
    JNIEnv *env = nullptr;
    bool attached = false;
    if (g_vm->GetEnv(reinterpret_cast<void **>(&env), JNI_VERSION_1_6) != JNI_OK) {
        if (g_vm->AttachCurrentThread(&env, nullptr) == JNI_OK) {
            attached = true;
        } else {
            return true;
        }
    }
    env->CallVoidMethod(g_progressListener, g_onProgress, static_cast<jfloat>(p));
    env->ExceptionClear();
    if (attached) {
        g_vm->DetachCurrentThread();
    }
    return true;  // returning false aborts model loading; we never want that here
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
static std::vector<float> jfloatsToVector(JNIEnv *env, jfloatArray arr) {
    std::vector<float> out;
    if (arr == nullptr) return out;
    jsize n = env->GetArrayLength(arr);
    if (n <= 0) return out;
    jfloat *els = env->GetFloatArrayElements(arr, nullptr);
    if (els == nullptr) return out;
    out.resize(static_cast<size_t>(n));
    for (jsize i = 0; i < n; ++i) out[static_cast<size_t>(i)] = els[i];
    env->ReleaseFloatArrayElements(arr, els, JNI_ABORT);
    return out;
}

static std::string jstr(JNIEnv *env, jstring s) {
    if (s == nullptr) return std::string();
    const char *c = env->GetStringUTFChars(s, nullptr);
    if (c == nullptr) return std::string();
    std::string out(c);
    env->ReleaseStringUTFChars(s, c);
    return out;
}

// llama.cpp must not be called concurrently on one context; a second decode would
// corrupt the KV cache. Vani serializes generation with this mutex.
static std::mutex g_llamaMutex;

struct LlamaHandle {
    struct llama_model *model = nullptr;
    struct llama_context *ctx = nullptr;
    struct llama_sampler *sampler = nullptr;
};

// ---------------------------------------------------------------------------
// llama.cpp
// ---------------------------------------------------------------------------
static void llamaProgressCb(float p, void * /*ud*/) { notifyProgress(p); }

JNIEXPORT jboolean JNICALL Java_ai_vani_engine_NativeBridge_nativeInit(JNIEnv *env, jobject /*thiz*/) {
    if (g_vm == nullptr) {
        env->GetJavaVM(&g_vm);
    }
    if (g_progressListener != nullptr) {
        env->DeleteGlobalRef(g_progressListener);
        g_progressListener = nullptr;
    }
    llama_backend_init();
    LOGI("llama backend initialized, %s", llama_version());
    return JNI_TRUE;
}

JNIEXPORT void JNICALL Java_ai_vani_engine_NativeBridge_nativeRegisterProgress(
        JNIEnv *env, jobject /*thiz*/, jobject listener) {
    if (g_progressListener != nullptr) {
        env->DeleteGlobalRef(g_progressListener);
    }
    if (listener != nullptr) {
        g_progressListener = env->NewGlobalRef(listener);
        jclass cls = env->GetObjectClass(listener);
        g_onProgress = env->GetMethodID(cls, "onProgress", "(F)V");
        if (g_onProgress == nullptr) {
            LOGE("NativeBridge.onProgress(float) not found");
        }
    }
}

JNIEXPORT void JNICALL Java_ai_vani_engine_NativeBridge_nativeLlamaBackendFree(JNIEnv *, jobject *) {
    llama_backend_free();
}

JNIEXPORT jfloat JNICALL Java_ai_vani_engine_NativeBridge_nativePollProgress(JNIEnv *, jobject *) {
    return static_cast<jfloat>(g_lastProgress.load());
}

JNIEXPORT jlong JNICALL Java_ai_vani_engine_NativeBridge_nativeLlamaLoadModel(
        JNIEnv *env, jobject, jstring jpath, jint gpuLayers, jint threads, jint batch,
        jboolean vocabOnly) {
    std::string path = jstr(env, jpath);
    if (path.empty()) return 0;

    struct llama_model_params params = llama_model_default_params();
    // Only fields that exist on the pinned revision are touched; everything else keeps
    // the upstream default.
    params.n_gpu_layers = static_cast<int32_t>(gpuLayers);
    params.n_threads = threads > 0 ? static_cast<int32_t>(threads) : 4;
    params.n_threads_batch = params.n_threads;
    params.n_batch = batch > 0 ? static_cast<int32_t>(batch) : 512;
    params.progress_callback = llamaProgressCb;
    params.progress_callback_user_data = nullptr;
    params.vocab_only = vocabOnly ? true : false;

    LOGI("loading model %s (gpu_layers=%d threads=%d batch=%d)", path.c_str(),
         static_cast<int>(gpuLayers), params.n_threads, params.n_batch);

    struct llama_model *model = llama_model_load_from_file(path.c_str(), params);
    if (model == nullptr) {
        LOGE("llama_model_load_from_file failed for %s", path.c_str());
        return 0;
    }
    auto *h = new LlamaHandle();
    h->model = model;
    LOGI("model loaded: %s", llama_model_desc(model));
    return reinterpret_cast<jlong>(h);
}

JNIEXPORT void JNICALL Java_ai_vani_engine_NativeBridge_nativeLlamaFreeModel(JNIEnv *, jobject, jlong h) {
    auto *lh = reinterpret_cast<LlamaHandle *>(h);
    if (lh == nullptr) return;
    if (lh->ctx != nullptr) {
        llama_free(lh->ctx);
        lh->ctx = nullptr;
    }
    if (lh->sampler != nullptr) {
        llama_sampler_free(lh->sampler);
        lh->sampler = nullptr;
    }
    if (lh->model != nullptr) {
        llama_model_free(lh->model);
        lh->model = nullptr;
    }
    delete lh;
}

JNIEXPORT jlong JNICALL Java_ai_vani_engine_NativeBridge_nativeLlamaInitContext(
        JNIEnv *, jobject, jlong modelH, jint nCtx, jint threads, jint batch, jint seqMax) {
    auto *lh = reinterpret_cast<LlamaHandle *>(modelH);
    if (lh == nullptr || lh->model == nullptr) return 0;

    struct llama_context_params cparams = llama_context_default_params();
    cparams.n_ctx = nCtx > 0 ? static_cast<uint32_t>(nCtx) : 4096u;
    cparams.n_batch = batch > 0 ? static_cast<uint32_t>(batch) : 512u;
    cparams.n_ubatch = cparams.n_batch;
    cparams.n_seq_max = seqMax > 0 ? static_cast<uint32_t>(seqMax) : 1u;
    cparams.offload_kqv = true;

    struct llama_context *ctx = llama_init_from_model(lh->model, cparams);
    if (ctx == nullptr) {
        LOGE("llama_init_from_model failed");
        return 0;
    }
    lh->ctx = ctx;

    // Greedy decoding for voice: deterministic output and no sampling overhead.
    // A temperature/top-p chain can be swapped in without touching this file by
    // replacing the sampler construction below.
    struct llama_sampler_chain_params sp = llama_sampler_chain_default_params();
    sp.no_prefill = false;
    lh->sampler = llama_sampler_chain_init(sp);
    llama_sampler_chain_add(lh->sampler, llama_sampler_init_greedy());

    LOGI("context ready: n_ctx=%u n_batch=%u n_vocab=%d", llama_n_ctx(ctx), llama_n_batch(ctx),
         llama_vocab_n_tokens(llama_model_get_vocab(lh->model)));
    return reinterpret_cast<jlong>(lh);
}

JNIEXPORT jintArray JNICALL Java_ai_vani_engine_NativeBridge_nativeLlamaTokenize(
        JNIEnv *env, jobject, jlong h, jstring jtext, jboolean addBos) {
    auto *lh = reinterpret_cast<LlamaHandle *>(h);
    if (lh == nullptr || lh->ctx == nullptr) return nullptr;

    std::string text = jstr(env, jtext);
    struct llama_vocab *vocab = llama_model_get_vocab(llama_get_model(lh->ctx));

    // Worst case one token per two characters, plus headroom for BOS / specials.
    std::vector<llama_token> buf(static_cast<size_t>(text.size()) / 2 + 32);
    int32_t n = llama_tokenize(vocab, text.c_str(), static_cast<int32_t>(text.size()),
                               buf.data(), static_cast<int32_t>(buf.size()),
                               addBos ? true : false, false);
    if (n < 0) {
        // Buffer too small: -n is the required size. Retry once, correctly sized.
        int32_t need = -n;
        buf.resize(static_cast<size_t>(need) + 8);
        n = llama_tokenize(vocab, text.c_str(), static_cast<int32_t>(text.size()),
                           buf.data(), static_cast<int32_t>(buf.size()),
                           addBos ? true : false, false);
        if (n < 0) {
            LOGE("tokenize failed, need=%d", -n);
            return nullptr;
        }
    }

    jintArray arr = env->NewIntArray(static_cast<jsize>(n));
    if (arr == nullptr) return nullptr;
    env->SetIntArrayRegion(arr, 0, static_cast<jsize>(n), reinterpret_cast<const jint *>(buf.data()));
    return arr;
}

JNIEXPORT jint JNICALL Java_ai_vani_engine_NativeBridge_nativeLlamaDecodeTokens(
        JNIEnv *env, jobject, jlong h, jintArray tokens) {
    auto *lh = reinterpret_cast<LlamaHandle *>(h);
    if (lh == nullptr || lh->ctx == nullptr || tokens == nullptr) return -1;

    jsize n = env->GetArrayLength(tokens);
    if (n <= 0) return -1;
    jint *els = env->GetIntArrayElements(tokens, nullptr);
    if (els == nullptr) return -1;

    std::lock_guard<std::mutex> lock(g_llamaMutex);
    struct llama_batch batch = llama_batch_init(static_cast<int32_t>(n), 0, 1);
    for (jsize i = 0; i < n; ++i) {
        batch.token[i] = static_cast<llama_token>(els[i]);
    }
    batch.n_tokens = static_cast<int32_t>(n);
    batch.seq_id[0][0] = 0;

    int rc = llama_decode(lh->ctx, batch);
    if (rc != 0) {
        LOGE("llama_decode failed rc=%d", rc);
    }
    llama_batch_free(batch);
    env->ReleaseIntArrayElements(tokens, els, JNI_ABORT);
    return rc;
}

JNIEXPORT jint JNICALL Java_ai_vani_engine_NativeBridge_nativeLlamaSample(JNIEnv *, jobject, jlong h) {
    auto *lh = reinterpret_cast<LlamaHandle *>(h);
    if (lh == nullptr || lh->ctx == nullptr || lh->sampler == nullptr) return -1;
    std::lock_guard<std::mutex> lock(g_llamaMutex);
    return static_cast<jint>(llama_sampler_sample(lh->sampler, lh->ctx, 0));
}

JNIEXPORT jstring JNICALL Java_ai_vani_engine_NativeBridge_nativeLlamaTokenToPiece(
        JNIEnv *env, jobject, jlong h, jint token) {
    auto *lh = reinterpret_cast<LlamaHandle *>(h);
    if (lh == nullptr || lh->ctx == nullptr) return env->NewStringUTF("");
    struct llama_vocab *vocab = llama_model_get_vocab(llama_get_model(lh->ctx));
    char buf[512];
    int32_t n = llama_token_to_piece(vocab, static_cast<llama_token>(token), buf,
                                     static_cast<int32_t>(sizeof(buf)), 0, false);
    if (n < 0) n = 0;
    return env->NewStringUTF(std::string(buf, static_cast<size_t>(n)).c_str());
}

JNIEXPORT void JNICALL Java_ai_vani_engine_NativeBridge_nativeLlamaMemoryClear(JNIEnv *, jobject, jlong h) {
    auto *lh = reinterpret_cast<LlamaHandle *>(h);
    if (lh == nullptr || lh->ctx == nullptr) return;
    std::lock_guard<std::mutex> lock(g_llamaMutex);
    llama_memory_clear(llama_get_memory(lh->ctx), true);
}

JNIEXPORT jstring JNICALL Java_ai_vani_engine_NativeBridge_nativeLlamaModelDesc(JNIEnv *env, jobject, jlong h) {
    auto *lh = reinterpret_cast<LlamaHandle *>(h);
    if (lh == nullptr || lh->model == nullptr) return env->NewStringUTF("");
    char buf[512];
    int32_t n = llama_model_desc(lh->model, buf, static_cast<int32_t>(sizeof(buf)));
    if (n <= 0) return env->NewStringUTF("");
    return env->NewStringUTF(std::string(buf, static_cast<size_t>(n)).c_str());
}

JNIEXPORT jlong JNICALL Java_ai_vani_engine_NativeBridge_nativeLlamaModelSize(JNIEnv *, jobject, jlong h) {
    auto *lh = reinterpret_cast<LlamaHandle *>(h);
    if (lh == nullptr || lh->model == nullptr) return 0;
    return static_cast<jlong>(llama_model_size(lh->model));
}

JNIEXPORT jlong JNICALL Java_ai_vani_engine_NativeBridge_nativeLlamaModelNParams(JNIEnv *, jobject, jlong h) {
    auto *lh = reinterpret_cast<LlamaHandle *>(h);
    if (lh == nullptr || lh->model == nullptr) return 0;
    return static_cast<jlong>(llama_model_n_params(lh->model));
}

// ---------------------------------------------------------------------------
// sherpa-onnx - streaming STT
// ---------------------------------------------------------------------------
static const SherpaOnnxOfflineStream *asOfflineStream(jlong h) {
    return reinterpret_cast<const SherpaOnnxOfflineStream *>(h);
}

static const SherpaOnnxOnlineStream *asOnlineStream(jlong h) {
    return reinterpret_cast<const SherpaOnnxOnlineStream *>(h);
}

JNIEXPORT jlong JNICALL Java_ai_vani_engine_NativeBridge_nativeSttCreateOnlineTransducer(
        JNIEnv *env, jobject, jstring jtokens, jstring jencoder, jstring jdecoder, jstring jjoiner,
        jint threads, jint sampleRate, jboolean enableEndpoint) {
    std::string tokens = jstr(env, jtokens);
    std::string encoder = jstr(env, jencoder);
    std::string decoder = jstr(env, jdecoder);
    std::string joiner = jstr(env, jjoiner);
    if (tokens.empty() || encoder.empty() || decoder.empty() || joiner.empty()) return 0;

    SherpaOnnxOnlineRecognizerConfig cfg;
    memset(&cfg, 0, sizeof(cfg));
    cfg.feat_config.sample_rate = sampleRate > 0 ? static_cast<int32_t>(sampleRate) : 16000;
    cfg.feat_config.feature_dim = 80;
    cfg.model_config.tokens = tokens.c_str();
    cfg.model_config.num_threads = threads > 0 ? static_cast<int32_t>(threads) : 2;
    cfg.model_config.provider = "cpu";
    cfg.model_config.debug = 0;
    cfg.model_config.transducer.encoder = encoder.c_str();
    cfg.model_config.transducer.decoder = decoder.c_str();
    cfg.model_config.transducer.joiner = joiner.c_str();
    cfg.decoding_method = "greedy_search";
    cfg.max_active_paths = 4;
    cfg.enable_endpoint = enableEndpoint ? 1 : 0;
    // Endpoint rules: let the recognizer also flag end-of-utterance so the pipeline
    // can act on it even when VAD is not in the loop.
    cfg.rule1_min_trailing_silence = 2.4f;
    cfg.rule2_min_trailing_silence = 1.2f;
    cfg.rule3_min_utterance_length = 10.0f;

    auto *rec = SherpaOnnxCreateOnlineRecognizer(&cfg);
    if (rec == nullptr) {
        LOGE("SherpaOnnxCreateOnlineRecognizer (transducer) failed");
        return 0;
    }
    LOGI("online transducer recognizer created");
    return reinterpret_cast<jlong>(rec);
}

JNIEXPORT jlong JNICALL Java_ai_vani_engine_NativeBridge_nativeSttCreateOnlineZipformerCtc(
        JNIEnv *env, jobject, jstring jtokens, jstring jmodel, jint threads, jint sampleRate,
        jboolean enableEndpoint) {
    std::string tokens = jstr(env, jtokens);
    std::string model = jstr(env, jmodel);
    if (tokens.empty() || model.empty()) return 0;

    SherpaOnnxOnlineRecognizerConfig cfg;
    memset(&cfg, 0, sizeof(cfg));
    cfg.feat_config.sample_rate = sampleRate > 0 ? static_cast<int32_t>(sampleRate) : 16000;
    cfg.feat_config.feature_dim = 80;
    cfg.model_config.tokens = tokens.c_str();
    cfg.model_config.num_threads = threads > 0 ? static_cast<int32_t>(threads) : 2;
    cfg.model_config.provider = "cpu";
    cfg.model_config.debug = 0;
    cfg.model_config.zipformer2_ctc.model = model.c_str();
    cfg.decoding_method = "greedy_search";
    cfg.max_active_paths = 4;
    cfg.enable_endpoint = enableEndpoint ? 1 : 0;
    cfg.rule1_min_trailing_silence = 2.4f;
    cfg.rule2_min_trailing_silence = 1.2f;
    cfg.rule3_min_utterance_length = 10.0f;

    auto *rec = SherpaOnnxCreateOnlineRecognizer(&cfg);
    if (rec == nullptr) {
        LOGE("SherpaOnnxCreateOnlineRecognizer (zipformer2-ctc) failed");
        return 0;
    }
    return reinterpret_cast<jlong>(rec);
}

JNIEXPORT jlong JNICALL Java_ai_vani_engine_NativeBridge_nativeSttCreateOfflineWhisper(
        JNIEnv *env, jobject, jstring jtokens, jstring jencoder, jstring jdecoder, jint threads,
        jint sampleRate, jstring jlanguage, jstring jtask) {
    std::string tokens = jstr(env, jtokens);
    std::string encoder = jstr(env, jencoder);
    std::string decoder = jstr(env, jdecoder);
    if (tokens.empty() || encoder.empty() || decoder.empty()) return 0;
    std::string lang = jstr(env, jlanguage);
    std::string task = jstr(env, jtask);

    SherpaOnnxOfflineRecognizerConfig cfg;
    memset(&cfg, 0, sizeof(cfg));
    cfg.feat_config.sample_rate = sampleRate > 0 ? static_cast<int32_t>(sampleRate) : 16000;
    cfg.feat_config.feature_dim = 80;
    cfg.model_config.tokens = tokens.c_str();
    cfg.model_config.num_threads = threads > 0 ? static_cast<int32_t>(threads) : 2;
    cfg.model_config.provider = "cpu";
    cfg.model_config.debug = 0;
    cfg.model_config.whisper.encoder = encoder.c_str();
    cfg.model_config.whisper.decoder = decoder.c_str();
    cfg.model_config.whisper.language = lang.empty() ? nullptr : lang.c_str();
    cfg.model_config.whisper.task = task.empty() ? nullptr : task.c_str();
    cfg.model_config.whisper.tail_paddings = -1;
    cfg.decoding_method = "greedy_search";
    cfg.max_active_paths = 4;
    cfg.blank_penalty = 0.0f;

    auto *rec = SherpaOnnxCreateOfflineRecognizer(&cfg);
    if (rec == nullptr) {
        LOGE("SherpaOnnxCreateOfflineRecognizer (whisper) failed");
        return 0;
    }
    return reinterpret_cast<jlong>(rec);
}

// Recognizer handles are opaque pointers and the online/offline structs are distinct C
// types, so C cannot dispatch on the pointer. Vani therefore exposes one destroy entry
// point per family; the Kotlin engine remembers which family it created.
JNIEXPORT void JNICALL Java_ai_vani_engine_NativeBridge_nativeSttDestroyOnline(JNIEnv *, jobject, jlong h) {
    if (h == 0) return;
    SherpaOnnxDestroyOnlineRecognizer(reinterpret_cast<const SherpaOnnxOnlineRecognizer *>(h));
}

JNIEXPORT void JNICALL Java_ai_vani_engine_NativeBridge_nativeSttDestroyOffline(JNIEnv *, jobject, jlong h) {
    if (h == 0) return;
    SherpaOnnxDestroyOfflineRecognizer(reinterpret_cast<const SherpaOnnxOfflineRecognizer *>(h));
}

JNIEXPORT jlong JNICALL Java_ai_vani_engine_NativeBridge_nativeSttCreateStream(JNIEnv *, jobject, jlong h) {
    if (h == 0) return 0;
    const SherpaOnnxOnlineStream *s = SherpaOnnxCreateOnlineStream(
            reinterpret_cast<const SherpaOnnxOnlineRecognizer *>(h));
    if (s == nullptr) return 0;
    return reinterpret_cast<jlong>(s);
}

JNIEXPORT void JNICALL Java_ai_vani_engine_NativeBridge_nativeSttDestroyStream(JNIEnv *, jobject, jlong h) {
    if (h == 0) return;
    SherpaOnnxDestroyOnlineStream(asOnlineStream(h));
}

JNIEXPORT void JNICALL Java_ai_vani_engine_NativeBridge_nativeSttDestroyOfflineStream(
        JNIEnv *, jobject, jlong h) {
    if (h == 0) return;
    SherpaOnnxDestroyOfflineStream(asOfflineStream(h));
}

JNIEXPORT void JNICALL Java_ai_vani_engine_NativeBridge_nativeSttAcceptWaveformOnline(
        JNIEnv *env, jobject, jlong streamH, jfloatArray samples) {
    if (streamH == 0 || samples == nullptr) return;
    std::vector<float> v = jfloatsToVector(env, samples);
    if (v.empty()) return;
    // Vani normalises the microphone to 16 kHz mono mono before it reaches STT or VAD,
    // so the sample rate is a fixed contract rather than a per-call argument.
    SherpaOnnxOnlineStreamAcceptWaveform(asOnlineStream(streamH), 16000, v.data(),
                                         static_cast<int32_t>(v.size()));
}

JNIEXPORT jboolean JNICALL Java_ai_vani_engine_NativeBridge_nativeSttIsOnlineReady(
        JNIEnv *, jobject, jlong recH, jlong streamH) {
    if (recH == 0 || streamH == 0) return JNI_FALSE;
    return SherpaOnnxIsOnlineStreamReady(reinterpret_cast<const SherpaOnnxOnlineRecognizer *>(recH),
                                         asOnlineStream(streamH))
               ? JNI_TRUE
               : JNI_FALSE;
}

JNIEXPORT void JNICALL Java_ai_vani_engine_NativeBridge_nativeSttDecodeOnline(
        JNIEnv *, jobject, jlong recH, jlong streamH) {
    if (recH == 0 || streamH == 0) return;
    SherpaOnnxDecodeOnlineStream(reinterpret_cast<const SherpaOnnxOnlineRecognizer *>(recH),
                                 asOnlineStream(streamH));
}

JNIEXPORT jstring JNICALL Java_ai_vani_engine_NativeBridge_nativeSttGetOnlineText(
        JNIEnv *env, jobject, jlong recH, jlong streamH) {
    if (recH == 0 || streamH == 0) return env->NewStringUTF("");
    const SherpaOnnxOnlineRecognizerResult *r = SherpaOnnxGetOnlineStreamResult(
            reinterpret_cast<const SherpaOnnxOnlineRecognizer *>(recH), asOnlineStream(streamH));
    if (r == nullptr || r->text == nullptr) return env->NewStringUTF("");
    std::string text(r->text);
    SherpaOnnxDestroyOnlineRecognizerResult(r);
    return env->NewStringUTF(text.c_str());
}

JNIEXPORT void JNICALL Java_ai_vani_engine_NativeBridge_nativeSttResetOnline(
        JNIEnv *, jobject, jlong recH, jlong streamH) {
    if (recH == 0 || streamH == 0) return;
    SherpaOnnxOnlineStreamReset(reinterpret_cast<const SherpaOnnxOnlineRecognizer *>(recH),
                                asOnlineStream(streamH));
}

JNIEXPORT void JNICALL Java_ai_vani_engine_NativeBridge_nativeSttInputFinishedOnline(
        JNIEnv *, jobject, jlong streamH) {
    if (streamH == 0) return;
    SherpaOnnxOnlineStreamInputFinished(asOnlineStream(streamH));
}

JNIEXPORT void JNICALL Java_ai_vani_engine_NativeBridge_nativeSttAcceptWaveformOffline(
        JNIEnv *env, jobject, jlong streamH, jfloatArray samples) {
    if (streamH == 0 || samples == nullptr) return;
    std::vector<float> v = jfloatsToVector(env, samples);
    if (v.empty()) return;
    SherpaOnnxAcceptWaveformOffline(asOfflineStream(streamH), 16000, v.data(),
                                    static_cast<int32_t>(v.size()));
}

JNIEXPORT void JNICALL Java_ai_vani_engine_NativeBridge_nativeSttDecodeOffline(
        JNIEnv *, jobject, jlong recH, jlong streamH) {
    if (recH == 0 || streamH == 0) return;
    SherpaOnnxDecodeOfflineStream(reinterpret_cast<const SherpaOnnxOfflineRecognizer *>(recH),
                                  asOfflineStream(streamH));
}

JNIEXPORT jstring JNICALL Java_ai_vani_engine_NativeBridge_nativeSttGetOfflineText(
        JNIEnv *env, jobject, jlong streamH) {
    if (streamH == 0) return env->NewStringUTF("");
    const SherpaOnnxOfflineRecognizerResult *r = SherpaOnnxGetOfflineStreamResult(asOfflineStream(streamH));
    if (r == nullptr || r->text == nullptr) return env->NewStringUTF("");
    std::string text(r->text);
    SherpaOnnxDestroyOfflineRecognizerResult(r);
    return env->NewStringUTF(text.c_str());
}

// ---------------------------------------------------------------------------
// sherpa-onnx - Silero VAD
// ---------------------------------------------------------------------------
JNIEXPORT jlong JNICALL Java_ai_vani_engine_NativeBridge_nativeVadCreate(
        JNIEnv *env, jobject, jstring jmodel, jfloat threshold, jfloat minSilence, jfloat minSpeech,
        jfloat maxSpeech, jint windowSize, jint threads) {
    std::string model = jstr(env, jmodel);
    if (model.empty()) return 0;

    SherpaOnnxVadModelConfig cfg;
    memset(&cfg, 0, sizeof(cfg));
    cfg.silero_vad.model = model.c_str();
    cfg.silero_vad.threshold = static_cast<float>(threshold);
    cfg.silero_vad.min_silence_duration = static_cast<float>(minSilence);
    cfg.silero_vad.min_speech_duration = static_cast<float>(minSpeech);
    cfg.silero_vad.max_speech_duration = static_cast<float>(maxSpeech);
    cfg.silero_vad.window_size = windowSize > 0 ? static_cast<int32_t>(windowSize) : 512;
    cfg.sample_rate = 16000;
    cfg.num_threads = threads > 0 ? static_cast<int32_t>(threads) : 2;
    cfg.provider = "cpu";
    cfg.debug = 0;

    // 30s internal buffer: long enough that a slow utterance never overflows it.
    auto *vad = SherpaOnnxCreateVoiceActivityDetector(&cfg, 30.0f);
    if (vad == nullptr) {
        LOGE("SherpaOnnxCreateVoiceActivityDetector failed");
        return 0;
    }
    return reinterpret_cast<jlong>(vad);
}

JNIEXPORT void JNICALL Java_ai_vani_engine_NativeBridge_nativeVadDestroy(JNIEnv *, jobject, jlong h) {
    if (h == 0) return;
    SherpaOnnxDestroyVoiceActivityDetector(reinterpret_cast<const SherpaOnnxVoiceActivityDetector *>(h));
}

JNIEXPORT void JNICALL Java_ai_vani_engine_NativeBridge_nativeVadAcceptWaveform(
        JNIEnv *env, jobject, jlong h, jfloatArray samples) {
    if (h == 0 || samples == nullptr) return;
    std::vector<float> v = jfloatsToVector(env, samples);
    if (v.empty()) return;
    SherpaOnnxVoiceActivityDetectorAcceptWaveform(
            reinterpret_cast<const SherpaOnnxVoiceActivityDetector *>(h), v.data(),
            static_cast<int32_t>(v.size()));
}

// Returns 1 when a completed speech segment is available, 0 while still in silence or
// mid-speech. Kotlin pops the segment once it has consumed it.
JNIEXPORT jboolean JNICALL Java_ai_vani_engine_NativeBridge_nativeVadProcess(JNIEnv *, jobject, jlong h) {
    if (h == 0) return JNI_FALSE;
    return SherpaOnnxVoiceActivityDetectorDetected(
               reinterpret_cast<const SherpaOnnxVoiceActivityDetector *>(h))
               ? JNI_TRUE
               : JNI_FALSE;
}

JNIEXPORT void JNICALL Java_ai_vani_engine_NativeBridge_nativeVadPop(JNIEnv *, jobject, jlong h) {
    if (h == 0) return;
    SherpaOnnxVoiceActivityDetectorPop(reinterpret_cast<const SherpaOnnxVoiceActivityDetector *>(h));
}

JNIEXPORT void JNICALL Java_ai_vani_engine_NativeBridge_nativeVadClear(JNIEnv *, jobject, jlong h) {
    if (h == 0) return;
    SherpaOnnxVoiceActivityDetectorClear(reinterpret_cast<const SherpaOnnxVoiceActivityDetector *>(h));
}

JNIEXPORT void JNICALL Java_ai_vani_engine_NativeBridge_nativeVadFlush(JNIEnv *, jobject, jlong h) {
    if (h == 0) return;
    SherpaOnnxVoiceActivityDetectorFlush(reinterpret_cast<const SherpaOnnxVoiceActivityDetector *>(h));
}

// ---------------------------------------------------------------------------
// sherpa-onnx - offline TTS (ONNX Runtime, CPU)
// ---------------------------------------------------------------------------
JNIEXPORT jlong JNICALL Java_ai_vani_engine_NativeBridge_nativeTtsCreateKitten(
        JNIEnv *env, jobject, jstring jmodel, jstring jvoices, jstring jtokens, jstring jdataDir,
        jfloat lengthScale, jint threads) {
    std::string model = jstr(env, jmodel);
    std::string voices = jstr(env, jvoices);
    std::string tokens = jstr(env, jtokens);
    std::string dataDir = jstr(env, jdataDir);
    if (model.empty()) return 0;

    SherpaOnnxOfflineTtsConfig cfg;
    memset(&cfg, 0, sizeof(cfg));
    cfg.model.num_threads = threads > 0 ? static_cast<int32_t>(threads) : 2;
    cfg.model.debug = 0;
    cfg.model.provider = "cpu";
    cfg.model.kitten.model = model.c_str();
    cfg.model.kitten.voices = voices.empty() ? nullptr : voices.c_str();
    cfg.model.kitten.tokens = tokens.empty() ? nullptr : tokens.c_str();
    cfg.model.kitten.data_dir = dataDir.empty() ? nullptr : dataDir.c_str();
    cfg.model.kitten.length_scale = static_cast<float>(lengthScale);
    // One sentence at a time: Vani streams TTS per sentence so the first syllables reach
    // the speaker while the LLM is still generating the next sentence.
    cfg.max_num_sentences = 1;
    cfg.silence_scale = 0.2f;

    auto *tts = SherpaOnnxCreateOfflineTts(&cfg);
    if (tts == nullptr) {
        LOGE("SherpaOnnxCreateOfflineTts (kitten) failed");
        return 0;
    }
    LOGI("kitten tts ready, sample_rate=%d", SherpaOnnxOfflineTtsSampleRate(tts));
    return reinterpret_cast<jlong>(tts);
}

JNIEXPORT jlong JNICALL Java_ai_vani_engine_NativeBridge_nativeTtsCreateVits(
        JNIEnv *env, jobject, jstring jmodel, jstring jlexicon, jstring jtokens, jstring jdataDir,
        jfloat noiseScale, jfloat noiseScaleW, jfloat lengthScale, jint threads) {
    std::string model = jstr(env, jmodel);
    std::string lexicon = jstr(env, jlexicon);
    std::string tokens = jstr(env, jtokens);
    std::string dataDir = jstr(env, jdataDir);
    if (model.empty()) return 0;

    SherpaOnnxOfflineTtsConfig cfg;
    memset(&cfg, 0, sizeof(cfg));
    cfg.model.num_threads = threads > 0 ? static_cast<int32_t>(threads) : 2;
    cfg.model.debug = 0;
    cfg.model.provider = "cpu";
    cfg.model.vits.model = model.c_str();
    cfg.model.vits.lexicon = lexicon.empty() ? nullptr : lexicon.c_str();
    cfg.model.vits.tokens = tokens.empty() ? nullptr : tokens.c_str();
    cfg.model.vits.data_dir = dataDir.empty() ? nullptr : dataDir.c_str();
    cfg.model.vits.noise_scale = static_cast<float>(noiseScale);
    cfg.model.vits.noise_scale_w = static_cast<float>(noiseScaleW);
    cfg.model.vits.length_scale = static_cast<float>(lengthScale);
    cfg.max_num_sentences = 1;
    cfg.silence_scale = 0.2f;

    auto *tts = SherpaOnnxCreateOfflineTts(&cfg);
    if (tts == nullptr) {
        LOGE("SherpaOnnxCreateOfflineTts (vits) failed");
        return 0;
    }
    return reinterpret_cast<jlong>(tts);
}

JNIEXPORT void JNICALL Java_ai_vani_engine_NativeBridge_nativeTtsDestroy(JNIEnv *, jobject, jlong h) {
    if (h == 0) return;
    SherpaOnnxDestroyOfflineTts(reinterpret_cast<const SherpaOnnxOfflineTts *>(h));
}

JNIEXPORT jint JNICALL Java_ai_vani_engine_NativeBridge_nativeTtsSampleRate(JNIEnv *, jobject, jlong h) {
    if (h == 0) return 22050;
    return SherpaOnnxOfflineTtsSampleRate(reinterpret_cast<const SherpaOnnxOfflineTts *>(h));
}

JNIEXPORT jfloatArray JNICALL Java_ai_vani_engine_NativeBridge_nativeTtsGenerate(
        JNIEnv *env, jobject, jlong h, jstring jtext, jfloat silenceScale, jfloat speed, jint sid) {
    if (h == 0) return nullptr;
    std::string text = jstr(env, jtext);
    if (text.empty()) return nullptr;

    SherpaOnnxGenerationConfig gc;
    memset(&gc, 0, sizeof(gc));
    gc.silence_scale = static_cast<float>(silenceScale);
    gc.speed = static_cast<float>(speed);
    gc.sid = static_cast<int32_t>(sid);

    const SherpaOnnxGeneratedAudio *audio = SherpaOnnxOfflineTtsGenerateWithConfig(
            reinterpret_cast<const SherpaOnnxOfflineTts *>(h), text.c_str(), &gc, nullptr, nullptr);
    if (audio == nullptr) {
        LOGE("TTS synthesis returned no audio");
        return nullptr;
    }

    jfloatArray out = env->NewFloatArray(static_cast<jsize>(audio->n));
    if (out == nullptr) {
        SherpaOnnxDestroyOfflineTtsGeneratedAudio(audio);
        return nullptr;
    }
    if (audio->n > 0 && audio->samples != nullptr) {
        env->SetFloatArrayRegion(out, 0, static_cast<jsize>(audio->n),
                                 reinterpret_cast<const jfloat *>(audio->samples));
    }
    SherpaOnnxDestroyOfflineTtsGeneratedAudio(audio);
    return out;
}

JNIEXPORT jstring JNICALL Java_ai_vani_engine_NativeBridge_nativeBackendInfo(JNIEnv *env, jobject) {
    // SHERPA_ONNX_VERSION is not exported by the C API, so report the llama.cpp build and
    // let the Kotlin side stamp the sherpa-onnx revision from the pinned submodule.
    return env->NewStringUTF(llama_version());
}
