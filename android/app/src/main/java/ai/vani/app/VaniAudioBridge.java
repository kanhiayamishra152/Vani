package ai.vani.app;

import android.Manifest;
import android.content.pm.PackageManager;
import android.media.AudioFormat;
import android.media.AudioRecord;
import android.media.MediaRecorder;
import android.util.Log;

/**
 * Vani AI v1.3.0 — unified native microphone capture.
 *
 * Root cause of "Could not receive audio input": WebView getUserMedia /
 * webkitSpeechRecognition is unreliable inside a custom WebView and collides
 * with native AudioRecord. ALL mic capture now flows through this single
 * AudioRecord bridge (MIC, 16 kHz, mono, 16-bit PCM) straight into sherpa-onnx
 * offline ASR — no getUserMedia, no base64 JS round-trip, and never two audio
 * consumers at once. The Android SpeechRecognizer fallback owns the mic only
 * when no offline ASR model is installed (this bridge is stopped first).
 */
public final class VaniAudioBridge {
    private static final String TAG = "VaniAudio";
    public static final int SAMPLE_RATE = 16000;

    public interface Sink { void accept(float[] samples, int len); }

    private final MainActivity act;
    private volatile AudioRecord record;
    private volatile Thread thread;
    private volatile boolean active = false;
    private final Sink sink;

    VaniAudioBridge(MainActivity act, Sink sink) { this.act = act; this.sink = sink; }

    public boolean hasPermission() {
        return act.checkSelfPermission(Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED;
    }

    public boolean isActive() { return active; }

    /** Start capture. Returns false if permission is missing or the mic is busy. */
    public synchronized boolean start() {
        if (active) return true;
        if (!hasPermission()) { Log.w(TAG, "RECORD_AUDIO not granted"); return false; }
        int min = AudioRecord.getMinBufferSize(SAMPLE_RATE, AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT);
        if (min <= 0) min = SAMPLE_RATE * 2; // 1 s fallback
        int bufBytes = Math.max(min * 2, 16000);
        AudioRecord r;
        try {
            r = new AudioRecord(MediaRecorder.AudioSource.MIC, SAMPLE_RATE,
                    AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT, bufBytes);
        } catch (Exception e) { Log.e(TAG, "AudioRecord init", e); return false; }
        if (r.getState() != AudioRecord.STATE_INITIALIZED) { Log.e(TAG, "AudioRecord not initialized"); try { r.release(); } catch (Exception ignored) {} return false; }
        record = r;
        active = true;
        try { r.startRecording(); } catch (Exception e) { Log.e(TAG, "startRecording", e); active = false; try { r.release(); } catch (Exception ignored) {} record = null; return false; }
        thread = new Thread(() -> {
            short[] buf = new short[1600]; // 100 ms @ 16 kHz
            float[] f = new float[1600];
            android.os.Process.setThreadPriority(android.os.Process.THREAD_PRIORITY_AUDIO);
            while (active) {
                int n;
                try { n = r.read(buf, 0, buf.length); } catch (Exception e) { break; }
                if (n < 0) { Log.w(TAG, "AudioRecord read error " + n); break; }
                if (n == 0) continue;
                for (int i = 0; i < n; i++) f[i] = buf[i] / 32768.0f;
                try { sink.accept(f, n); } catch (Throwable ignored) {}
            }
        }, "vani-audio-capture");
        thread.setDaemon(true);
        thread.start();
        Log.i(TAG, "native mic capture started (16kHz mono PCM16)");
        return true;
    }

    public synchronized void stop() {
        active = false;
        try { if (record != null) record.stop(); } catch (Exception ignored) {}
        try { if (record != null) record.release(); } catch (Exception ignored) {}
        record = null;
        Thread t = thread; thread = null;
        if (t != null) { try { t.join(300); } catch (InterruptedException ignored) {} }
    }
}
