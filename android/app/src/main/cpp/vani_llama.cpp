// Vani AI — llama.cpp v0.8.0 JNI bridge.
// Text + vision (mtmd) GGUF inference with chat-template rendering, prefix
// KV-cache reuse, streaming token callbacks and instant stop (barge-in).
#include <jni.h>
#include <android/log.h>

#include <algorithm>
#include <atomic>
#include <chrono>
#include <cstring>
#include <mutex>
#include <memory>
#include <stdexcept>
#include <string>
#include <vector>

#include "llama.h"
#include "common.h"
#include "chat.h"
#include "sampling.h"
#include "json.h"
#include "mtmd.h"
#include "mtmd-helper.h"

#define LOG_TAG "VaniLlama"
#define LOGI(...) __android_log_print(ANDROID_LOG_INFO, LOG_TAG, __VA_ARGS__)
#define LOGE(...) __android_log_print(ANDROID_LOG_ERROR, LOG_TAG, __VA_ARGS__)

namespace {

struct VaniCtx {
    llama_model * model = nullptr;
    llama_context * ctx = nullptr;
    std::atomic<mtmd_context *> mctx{nullptr};
    common_chat_templates_ptr tmpls;
    const llama_vocab * vocab = nullptr;
    std::vector<llama_token> prev_tokens;   // prefix KV cache
    std::atomic<bool> stop{false};
    std::mutex mtx;
    int n_threads = 4;
    int n_batch = 512;
    std::string mmproj_path;                // deferred vision/audio projector
};

void llama_log_to_android(ggml_log_level level, const char * text, void *) {
    if (level >= GGML_LOG_LEVEL_WARN) __android_log_print(ANDROID_LOG_WARN, LOG_TAG, "%s", text);
}

void throw_runtime(JNIEnv * env, const char * message) {
    if (!env || env->ExceptionCheck()) return;
    jclass cls = env->FindClass("java/lang/RuntimeException");
    if (!cls) return;
    env->ThrowNew(cls, message ? message : "Native model operation failed");
    env->DeleteLocalRef(cls);
}

std::string jstr(JNIEnv * env, jstring s) {
    if (!s) return "";
    const char * c = env->GetStringUTFChars(s, nullptr);
    std::string out(c ? c : "");
    if (c) env->ReleaseStringUTFChars(s, c);
    return out;
}

// UTF-8 safe jstring (token pieces may contain any Unicode).
jstring jstringFromUtf8(JNIEnv * env, const std::string & s) {
    jclass strCls = env->FindClass("java/lang/String");
    jmethodID ctor = env->GetMethodID(strCls, "<init>", "([BLjava/lang/String;)V");
    jbyteArray bytes = env->NewByteArray((jsize) s.size());
    env->SetByteArrayRegion(bytes, 0, (jsize) s.size(), reinterpret_cast<const jbyte *>(s.data()));
    jstring charset = env->NewStringUTF("UTF-8");
    jstring out = (jstring) env->NewObject(strCls, ctor, bytes, charset);
    env->DeleteLocalRef(bytes);
    env->DeleteLocalRef(charset);
    env->DeleteLocalRef(strCls);
    return out;
}

std::vector<unsigned char> base64_decode(const std::string & in) {
    static const int8_t T[256] = {
        -1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,
        -1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,62,-1,-1,-1,63,52,53,54,55,56,57,58,59,60,61,-1,-1,-1,-1,-1,-1,
        -1, 0, 1, 2, 3, 4, 5, 6, 7, 8, 9,10,11,12,13,14,15,16,17,18,19,20,21,22,23,24,25,-1,-1,-1,-1,-1,
        -1,26,27,28,29,30,31,32,33,34,35,36,37,38,39,40,41,42,43,44,45,46,47,48,49,50,51,-1,-1,-1,-1,-1,
        -1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,
        -1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,
        -1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,
        -1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1
    };
    std::vector<unsigned char> out;
    out.reserve(in.size() * 3 / 4);
    int val = 0, bits = -8;
    for (unsigned char c : in) {
        if (c == '=') break;
        int8_t d = T[c];
        if (d < 0) continue;
        val = (val << 6) + d;
        bits += 6;
        if (bits >= 0) { out.push_back((unsigned char) ((val >> bits) & 0xff)); bits -= 8; }
    }
    return out;
}

// Longest prefix of s that ends on a complete, structurally valid UTF-8
// code point. llama byte pieces can split a code point across tokens; the
// incomplete tail must stay in the native buffer until a later piece arrives.
size_t utf8_complete_prefix(const std::string & s) {
    size_t i = 0, last = 0;
    while (i < s.size()) {
        const unsigned char c = (unsigned char) s[i];
        int len = 0;
        if (c <= 0x7f) len = 1;
        else if (c >= 0xc2 && c <= 0xdf) len = 2;
        else if (c >= 0xe0 && c <= 0xef) len = 3;
        else if (c >= 0xf0 && c <= 0xf4) len = 4;
        else { i++; last = i; continue; } // isolated invalid byte: Java replaces it safely
        if (i + len > s.size()) break;   // incomplete code point: retain it
        bool valid = true;
        for (int k = 1; k < len; k++) {
            const unsigned char d = (unsigned char) s[i + k];
            if ((d & 0xc0) != 0x80) { valid = false; break; }
        }
        if (valid && len >= 3) {
            const unsigned char d = (unsigned char) s[i + 1];
            if ((c == 0xe0 && d < 0xa0) || (c == 0xed && d > 0x9f) ||
                (c == 0xf0 && d < 0x90) || (c == 0xf4 && d > 0x8f)) valid = false;
        }
        if (!valid) { i++; last = i; continue; }
        i += len;
        last = i;
    }
    return last;
}

// Do not stream a suffix that may be the beginning of a stop string. This
// keeps stop detection atomic across token/chunk boundaries and ensures a
// later stop match can never move the emitted-byte cursor backwards.
size_t stop_prefix_suffix(const std::string & s, const std::vector<std::string> & stops) {
    size_t hold = 0;
    for (const auto & stop : stops) {
        if (stop.empty()) continue;
        const size_t max = std::min(s.size(), stop.size() - 1);
        for (size_t n = max; n > 0; n--) {
            if (s.compare(s.size() - n, n, stop, 0, n) == 0) {
                hold = std::max(hold, n);
                break;
            }
        }
    }
    return hold;
}

std::vector<llama_token> tokenize(const llama_vocab * vocab, const std::string & text, bool add_special) {
    int n = llama_tokenize(vocab, text.c_str(), (int32_t) text.size(), nullptr, 0, add_special, true);
    if (n < 0) n = -n;
    std::vector<llama_token> tokens(n);
    int rc = llama_tokenize(vocab, text.c_str(), (int32_t) text.size(), tokens.data(), (int32_t) tokens.size(), add_special, true);
    if (rc < 0) return {};
    tokens.resize(rc);
    return tokens;
}

std::string token_piece(const llama_vocab * vocab, llama_token tok) {
    char buf[512];
    int n = llama_token_to_piece(vocab, tok, buf, sizeof(buf), 0, false);
    if (n < 0) {
        std::vector<char> big(-n);
        n = llama_token_to_piece(vocab, tok, big.data(), (int32_t) big.size(), 0, false);
        if (n <= 0) return "";
        return std::string(big.data(), n);
    }
    return std::string(buf, n);
}

void replace_all(std::string & s, const std::string & from, const std::string & to) {
    if (from.empty()) return;
    size_t pos = 0;
    while ((pos = s.find(from, pos)) != std::string::npos) { s.replace(pos, from.size(), to); pos += to.size(); }
}

struct Callback {
    JNIEnv * env;
    jobject obj;
    jmethodID mToken, mDone, mError;
    void token(const std::string & t) {
        jstring s = jstringFromUtf8(env, t);
        env->CallVoidMethod(obj, mToken, s);
        env->DeleteLocalRef(s);
    }
    void done(const std::string & stats) {
        jstring s = env->NewStringUTF(stats.c_str());
        env->CallVoidMethod(obj, mDone, s);
        env->DeleteLocalRef(s);
    }
    void error(const std::string & e) {
        jstring s = jstringFromUtf8(env, e);
        env->CallVoidMethod(obj, mError, s);
        env->DeleteLocalRef(s);
    }
};

} // namespace

extern "C" {

JNIEXPORT void JNICALL Java_ai_vani_app_LlmEngine_nativeInit(JNIEnv *, jclass) {
    llama_backend_init();
    llama_log_set(llama_log_to_android, nullptr);
    mtmd_helper_log_set(llama_log_to_android, nullptr);
    LOGI("llama backend initialized (%s)", llama_print_system_info());
}

JNIEXPORT jlong JNICALL Java_ai_vani_app_LlmEngine_nativeLoad(
        JNIEnv * env, jclass, jstring jpath, jstring jmmproj,
        jint nCtx, jint nThreads, jint nBatch, jboolean flashAttn) {
    llama_model * model = nullptr;
    llama_context * ctx = nullptr;
    VaniCtx * v = nullptr;
    try {
        std::string path = jstr(env, jpath);
        std::string mmproj = jstr(env, jmmproj);
        if (path.empty()) throw std::runtime_error("Model path is empty");

        llama_model_params mparams = llama_model_default_params();
        mparams.n_gpu_layers = 0;
        mparams.load_mode = LLAMA_LOAD_MODE_MMAP;

        model = llama_model_load_from_file(path.c_str(), mparams);
        if (!model) {
            LOGE("model load failed: %s", path.c_str());
            return 0;
        }

        llama_context_params cparams = llama_context_default_params();
        cparams.n_ctx = (uint32_t) nCtx;
        cparams.n_batch = (uint32_t) nBatch;
        cparams.n_ubatch = (uint32_t) std::min<int>(nBatch, 256);
        cparams.n_threads = nThreads;
        cparams.n_threads_batch = nThreads;
        cparams.flash_attn_type = flashAttn ? LLAMA_FLASH_ATTN_TYPE_ENABLED : LLAMA_FLASH_ATTN_TYPE_AUTO;
        cparams.type_k = GGML_TYPE_Q8_0;
        cparams.type_v = flashAttn ? GGML_TYPE_Q8_0 : GGML_TYPE_F16;
        cparams.embeddings = false;
        cparams.no_perf = true;

        ctx = llama_init_from_model(model, cparams);
        if (!ctx) throw std::runtime_error("Context initialization failed; insufficient native memory or unsupported model settings");

        v = new VaniCtx();
        v->model = model;
        v->ctx = ctx;
        v->vocab = llama_model_get_vocab(model);
        v->n_threads = nThreads;
        v->n_batch = nBatch;
        v->tmpls = common_chat_templates_init(model, "");
        if (!v->tmpls) throw std::runtime_error("Chat template initialization failed");
        if (!mmproj.empty()) v->mmproj_path = mmproj;

        LOGI("model ready: ctx=%d threads=%d batch=%d mmproj=%s", nCtx, nThreads, nBatch,
             v->mmproj_path.empty() ? "none" : "on-demand");
        return reinterpret_cast<jlong>(v);
    } catch (const std::exception & e) {
        LOGE("nativeLoad exception: %s", e.what());
        if (v) v->tmpls.reset();
        delete v;
        if (ctx) llama_free(ctx);
        if (model) llama_model_free(model);
        throw_runtime(env, e.what());
        return 0;
    } catch (...) {
        LOGE("nativeLoad unknown exception");
        if (v) v->tmpls.reset();
        delete v;
        if (ctx) llama_free(ctx);
        if (model) llama_model_free(model);
        throw_runtime(env, "Native model allocation failed");
        return 0;
    }
}

JNIEXPORT jstring JNICALL Java_ai_vani_app_LlmEngine_nativeStatus(JNIEnv * env, jclass, jlong handle) {
    auto * v = reinterpret_cast<VaniCtx *>(handle);
    common_json j = common_json::object();
    if (v) {
        j["nCtx"] = (int) llama_n_ctx(v->ctx);
        j["nCtxTrain"] = llama_model_n_ctx_train(v->model);
        j["nThreads"] = v->n_threads;
        // Do not call into mtmd while another thread may be attaching or
        // destroying it. The path describes capability; the atomic pointer
        // describes residency without a use-after-free race.
        j["vision"] = !v->mmproj_path.empty();
        j["audio"] = !v->mmproj_path.empty();
        j["mmprojLoaded"] = v->mctx.load() != nullptr;
    }
    return env->NewStringUTF(j.dump().c_str());
}

JNIEXPORT void JNICALL Java_ai_vani_app_LlmEngine_nativeGenerate(
        JNIEnv * env, jclass, jlong handle, jstring jmessages, jstring jparams,
        jstring jimages, jstring jgenId, jobject cbObj) {
    auto * v = reinterpret_cast<VaniCtx *>(handle);
    jclass cbCls = env->GetObjectClass(cbObj);
    Callback cb{env, cbObj,
                env->GetMethodID(cbCls, "onToken", "(Ljava/lang/String;)V"),
                env->GetMethodID(cbCls, "onDone", "(Ljava/lang/String;)V"),
                env->GetMethodID(cbCls, "onError", "(Ljava/lang/String;)V")};
    env->DeleteLocalRef(cbCls);
    if (!v || !v->model || !v->ctx) { cb.error("No model loaded"); return; }

    std::lock_guard<std::mutex> lock(v->mtx);
    const auto requestStart = std::chrono::steady_clock::now();
    v->stop = false;

    try {
        common_json messages = common_json::parse(jstr(env, jmessages));
        common_json params = common_json::parse(jstr(env, jparams));
        common_json images = common_json::parse(jstr(env, jimages));

        int maxTokens = params.contains("maxTokens") ? params.at("maxTokens").get<int>() : 1024;
        float temp = params.contains("temperature") ? (float) params.at("temperature").get<double>() : 0.7f;
        float topP = params.contains("topP") ? (float) params.at("topP").get<double>() : 0.9f;
        int topK = params.contains("topK") ? params.at("topK").get<int>() : 40;
        float repeat = params.contains("repeatPenalty") ? (float) params.at("repeatPenalty").get<double>() : 1.1f;
        bool thinking = params.contains("enableThinking") && params.at("enableThinking").get<bool>();

        // ---- chat template ----
        common_chat_templates_inputs inputs;
        inputs.add_generation_prompt = true;
        inputs.use_jinja = true;
        inputs.enable_thinking = thinking;
        for (size_t i = 0; i < messages.size(); i++) {
            const auto & m = messages.at(i);
            common_chat_msg msg;
            msg.role = m.at("role").get<std::string>();
            msg.content = m.contains("content") ? m.at("content").get<std::string>() : "";
            inputs.messages.push_back(std::move(msg));
        }
        common_chat_params cparams = common_chat_templates_apply(v->tmpls.get(), inputs);
        std::string prompt = cparams.prompt.str();
        // Some chat templates expose an empty additional stop. std::string::find("")
        // matches at offset zero, which used to truncate the very first token.
        std::vector<std::string> stopStrings;
        for (const auto & stop : cparams.additional_stops) {
            if (!stop.empty()) stopStrings.push_back(stop);
        }

        // ---- sampling ----
        common_params_sampling sp;
        sp.temp = temp;
        sp.top_k = topK;
        sp.top_p = topP;
        sp.penalty_repeat = repeat;
        sp.seed = (uint32_t) std::chrono::steady_clock::now().time_since_epoch().count();
        std::unique_ptr<common_sampler, decltype(&common_sampler_free)> smplOwner(
                common_sampler_init(v->model, sp), &common_sampler_free);
        common_sampler * smpl = smplOwner.get();
        if (!smpl) { cb.error("Failed to initialize the sampler"); return; }

        llama_memory_t mem = llama_get_memory(v->ctx);
        const int n_ctx = (int) llama_n_ctx(v->ctx);
        auto invalidateCache = [&]() {
            llama_memory_clear(mem, true);
            v->prev_tokens.clear();
        };
        llama_pos n_past = 0;
        size_t n_prompt = 0;
        size_t cachedTokens = 0;
        size_t evaluatedPromptTokens = 0;
        size_t promptTokenCount = 0;
        bool decodeFailed = false;
        mtmd_context * mctx = v->mctx.load();
        if (images.size() > 0 && mctx == nullptr)
            throw std::runtime_error("The vision/audio projector is not attached; image input was not discarded");
        bool hasImages = images.size() > 0;
        std::vector<llama_token> prompt_tokens;

        if (hasImages) {
            // ---- vision path: mtmd bitmaps + chunked eval ----
            std::string marker = mtmd_default_marker();
            replace_all(prompt, "<|image_pad|>", marker);
            replace_all(prompt, "<|image|>", marker);
            replace_all(prompt, "<start_of_image>", marker);
            replace_all(prompt, "<image>", marker);

            std::vector<mtmd_bitmap *> bitmaps;
            struct BitmapCleanup {
                std::vector<mtmd_bitmap *> & items;
                ~BitmapCleanup() { for (auto * b : items) mtmd_bitmap_free(b); }
            } bitmapCleanup{bitmaps};
            bitmaps.reserve(images.size());
            for (size_t i = 0; i < images.size(); i++) {
                std::string b64 = images.at(i).get<std::string>();
                size_t comma = b64.find(',');
                if (comma != std::string::npos) b64 = b64.substr(comma + 1);
                auto bytes = base64_decode(b64);
                if (bytes.empty()) throw std::runtime_error("Image input is empty or invalid");
                mtmd_helper_bitmap_wrapper w = mtmd_helper_bitmap_init_from_buf(
                        mctx, bytes.data(), bytes.size(), false, mtmd_helper_init_opt_default());
                if (!w.bitmap) throw std::runtime_error("Image decoding failed in the native projector");
                bitmaps.push_back(w.bitmap);
            }
            std::unique_ptr<mtmd_input_chunks, decltype(&mtmd_input_chunks_free)> chunks(
                    mtmd_input_chunks_init(), &mtmd_input_chunks_free);
            if (!chunks) throw std::runtime_error("Could not allocate multimodal input chunks");
            mtmd_input_text text{prompt.c_str(), prompt.size(), false, true};
            int32_t rc = mtmd_tokenize(mctx, chunks.get(), &text,
                                       bitmaps.empty() ? nullptr : bitmaps.data(), bitmaps.size());
            if (rc != 0) throw std::runtime_error("Failed to tokenize image input");
            llama_memory_clear(mem, true);
            llama_pos new_past = 0;
            rc = mtmd_helper_eval_chunks(mctx, v->ctx, chunks.get(), 0, 0, v->n_batch, true, &new_past);
            n_past = new_past;
            if (rc != 0) throw std::runtime_error("Image evaluation failed");
            v->prev_tokens.clear();
        } else {
            // ---- text path with prefix KV-cache reuse ----
            prompt_tokens = tokenize(v->vocab, prompt, false);
            if (prompt_tokens.empty()) { cb.error("Empty prompt"); return; }
            promptTokenCount = prompt_tokens.size();
            size_t keep = 0;
            while (keep < v->prev_tokens.size() && keep < prompt_tokens.size()
                   && v->prev_tokens[keep] == prompt_tokens[keep]) keep++;
            cachedTokens = keep;
            evaluatedPromptTokens = keep;
            if (!llama_memory_seq_rm(mem, 0, (llama_pos) keep, -1)) {
                // If sequence trimming is unsupported, never pretend the old
                // token prefix still describes the actual KV memory contents.
                invalidateCache();
                keep = 0;
                cachedTokens = 0;
                evaluatedPromptTokens = 0;
            }
            n_past = (llama_pos) keep;
            for (size_t i = keep; i < prompt_tokens.size() && !v->stop; ) {
                int32_t n = (int32_t) std::min<size_t>(v->n_batch, prompt_tokens.size() - i);
                llama_batch batch = llama_batch_get_one(prompt_tokens.data() + i, n);
                if (llama_decode(v->ctx, batch) != 0) {
                    invalidateCache();
                    cb.error("Prompt evaluation failed: the context window or mobile memory budget was exceeded");
                    return;
                }
                i += n;
                n_past += n;
                evaluatedPromptTokens += n;
            }
            n_prompt = prompt_tokens.size();
        }

        // ---- generation loop ----
        // v1.3.0 ZERO-OVERHEAD STREAMING: tokens are buffered natively and flushed
        // to the WebView at most every 32 ms (or every 5 tokens), so we never call
        // evaluateJavascript / re-parse the DOM once per token. TTFT is measured.
        auto t0 = std::chrono::steady_clock::now();
        auto promptDone = std::chrono::steady_clock::now();
        const double promptMs = std::chrono::duration<double, std::milli>(promptDone - requestStart).count();
        // Never ask the sampler to write beyond the actual context window.
        maxTokens = std::max(0, std::min(maxTokens, n_ctx - (int) n_past));
        if (maxTokens <= 0) {
            if (!hasImages) v->prev_tokens = prompt_tokens;
            cb.error("The context window is full. Start a new chat or increase n_ctx before generating again.");
            return;
        }
        std::string full, batchBuf;
        size_t emitted = 0;
        size_t stopAt = std::string::npos;
        int n_gen = 0, sinceFlush = 0;
        bool stopped = false;
        bool hitStop = false;
        double ttftMs = -1;
        auto lastFlush = std::chrono::steady_clock::now();
        auto flush = [&](bool force) {
            if (batchBuf.empty()) { if (force) lastFlush = std::chrono::steady_clock::now(); return; }
            auto now = std::chrono::steady_clock::now();
            double ms = std::chrono::duration<double, std::milli>(now - lastFlush).count();
            if (force || ms >= 32.0 || sinceFlush >= 5) {
                cb.token(batchBuf);
                batchBuf.clear();
                sinceFlush = 0;
                lastFlush = std::chrono::steady_clock::now();
            }
        };
        auto emitAvailable = [&](bool final) {
            const size_t limit = hitStop ? std::min(stopAt, full.size()) : full.size();
            if (limit <= emitted) return; // also protects a stop at/before the cursor
            const std::string pending = full.substr(emitted, limit - emitted);
            size_t valid = utf8_complete_prefix(pending);
            if (!final && !hitStop && valid > 0) {
                const size_t hold = stop_prefix_suffix(pending.substr(0, valid), stopStrings);
                valid -= std::min(valid, hold);
            }
            if (valid > 0) {
                batchBuf += pending.substr(0, valid);
                emitted += valid;
                sinceFlush++;
            }
        };

        while (n_gen < maxTokens) {
            if (v->stop) { stopped = true; break; }
            if (n_past >= n_ctx) break;
            llama_token tok = common_sampler_sample(smpl, v->ctx, -1);
            common_sampler_accept(smpl, tok, true);
            if (llama_vocab_is_eog(v->vocab, tok)) break;

            if (ttftMs < 0) ttftMs = std::chrono::duration<double, std::milli>(std::chrono::steady_clock::now() - requestStart).count();
            full += token_piece(v->vocab, tok);
            for (const auto & s : stopStrings) { // empty template stops were filtered above
                const size_t p = full.find(s);
                if (p != std::string::npos) { stopAt = p; hitStop = true; break; }
            }
            // Keep split UTF-8 bytes and possible stop-string prefixes buffered.
            // Never resize `full`: emitted remains a valid, monotonic cursor.
            emitAvailable(false);
            flush(hitStop);
            if (hitStop) break;

            n_gen++;
            prompt_tokens.push_back(tok);
            llama_batch batch = llama_batch_get_one(&tok, 1);
            if (llama_decode(v->ctx, batch) != 0) { decodeFailed = true; break; }
            n_past++;
        }
        emitAvailable(true); // release a false partial-stop suffix at natural EOF
        flush(true);         // final complete-UTF-8 batch

        if (decodeFailed) {
            invalidateCache();
            cb.error("Token evaluation failed. Any text already streamed has been kept; please retry.");
            return;
        }
        if (!hasImages) {
            // A Stop during prompt evaluation must not cache tokens that were
            // never decoded; the next turn can reuse only the real KV prefix.
            if (evaluatedPromptTokens < promptTokenCount) prompt_tokens.resize(evaluatedPromptTokens);
            v->prev_tokens = std::move(prompt_tokens);
        }

        if (!stopped && emitted == 0) {
            cb.error("The model ended without producing text. No partial UTF-8 or template stop bytes were emitted; please try again.");
            return;
        }
        double secs = std::chrono::duration<double>(std::chrono::steady_clock::now() - t0).count();
        common_json stats = common_json::object();
        stats["tokens"] = n_gen;
        stats["tps"] = secs > 0 ? n_gen / secs : 0.0;
        stats["msPerToken"] = n_gen > 0 ? secs * 1000.0 / n_gen : -1.0;
        stats["ttftMs"] = ttftMs;
        stats["promptMs"] = promptMs;
        stats["promptTokens"] = (int) n_prompt;
        stats["cachedTokens"] = (int) cachedTokens;
        stats["stopped"] = stopped;
        cb.done(stats.dump());
    } catch (const std::exception & e) {
        LOGE("generate: %s", e.what());
        cb.error(e.what());
    } catch (...) {
        cb.error("Generation failed");
    }
}

JNIEXPORT void JNICALL Java_ai_vani_app_LlmEngine_nativeStop(JNIEnv *, jclass, jlong handle) {
    auto * v = reinterpret_cast<VaniCtx *>(handle);
    if (v) v->stop = true;
}

// Attach the vision/audio projector for a multimodal turn (on-demand RAM).
JNIEXPORT jboolean JNICALL Java_ai_vani_app_LlmEngine_nativeAttachMmproj(JNIEnv * env, jclass, jlong handle, jstring jpath) {
    auto * v = reinterpret_cast<VaniCtx *>(handle);
    if (!v || !v->model) return JNI_FALSE;
    try {
        std::lock_guard<std::mutex> lock(v->mtx);
        if (v->mctx.load() != nullptr) return JNI_TRUE;
        std::string path = jstr(env, jpath);
        if (path.empty()) path = v->mmproj_path;
        if (path.empty()) return JNI_FALSE;
        mtmd_context_params mp = mtmd_context_params_default();
        mp.use_gpu = false;
        mp.n_threads = v->n_threads;
        mp.print_timings = false;
        mp.warmup = false;
        mp.flash_attn_type = LLAMA_FLASH_ATTN_TYPE_AUTO;
        mtmd_context * created = mtmd_init_from_file(path.c_str(), v->model, mp);
        if (!created) {
            LOGE("mmproj attach failed: %s", path.c_str());
            return JNI_FALSE;
        }
        v->mmproj_path = path;
        v->mctx.store(created);
        LOGI("mmproj attached (vision=%d audio=%d)", mtmd_support_vision(created), mtmd_support_audio(created));
        return JNI_TRUE;
    } catch (const std::exception & e) {
        LOGE("mmproj attach exception: %s", e.what());
        throw_runtime(env, e.what());
        return JNI_FALSE;
    } catch (...) {
        LOGE("mmproj attach unknown exception");
        throw_runtime(env, "Native projector allocation failed");
        return JNI_FALSE;
    }
}

// Detach + free the projector after a multimodal turn (returns ~480 MB RAM).
JNIEXPORT void JNICALL Java_ai_vani_app_LlmEngine_nativeDetachMmproj(JNIEnv *, jclass, jlong handle) {
    auto * v = reinterpret_cast<VaniCtx *>(handle);
    if (!v) return;
    try {
        std::lock_guard<std::mutex> lock(v->mtx);
        mtmd_context * old = v->mctx.exchange(nullptr);
        if (old) {
            mtmd_free(old);
            LOGI("mmproj detached (RAM freed)");
        }
    } catch (...) {
        LOGE("mmproj detach failed");
    }
}

JNIEXPORT void JNICALL Java_ai_vani_app_LlmEngine_nativeFree(JNIEnv *, jclass, jlong handle) {
    auto * v = reinterpret_cast<VaniCtx *>(handle);
    if (!v) return;
    try {
        {
            std::lock_guard<std::mutex> lock(v->mtx);
            mtmd_context * old = v->mctx.exchange(nullptr);
            if (old) mtmd_free(old);
            v->tmpls.reset();
            if (v->ctx) {
                llama_free(v->ctx);
                v->ctx = nullptr;
            }
            if (v->model) {
                llama_model_free(v->model);
                v->model = nullptr;
            }
        }
        // The lock must be released before its containing object is deleted.
        delete v;
    } catch (...) {
        LOGE("nativeFree failed");
    }
}

} // extern "C"
