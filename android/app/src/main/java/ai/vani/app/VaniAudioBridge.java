package ai.vani.app;

import android.Manifest;
import android.content.pm.PackageManager;
import android.media.AudioFormat;
import android.media.AudioRecord;
import android.media.MediaRecorder;
import android.util.Log;

/**
 * Single-owner 16 kHz mono microphone capture.
 *
 * Each start creates an independent session with its own running flag and
 * AudioRecord. The capture thread is the sole owner that releases its recorder;
 * stopping only signals and unblocks it. This prevents an old reader from using
 * a recorder released for a newer Live/dictation session.
 */
public final class VaniAudioBridge {
    private static final String TAG = "VaniAudio";
    public static final int SAMPLE_RATE = 16000;

    public interface Sink { void accept(float[] samples, int len); }

    private static final class Session {
        final AudioRecord record;
        volatile boolean running = true;
        volatile Thread thread;

        Session(AudioRecord record) { this.record = record; }
    }

    private final MainActivity act;
    private final Sink sink;
    private final Object sessionLock = new Object();
    private volatile Session session;

    VaniAudioBridge(MainActivity act, Sink sink) {
        this.act = act;
        this.sink = sink;
    }

    public boolean hasPermission() {
        return act.checkSelfPermission(Manifest.permission.RECORD_AUDIO)
                == PackageManager.PERMISSION_GRANTED;
    }

    public boolean isActive() {
        Session s = session;
        return s != null && s.running;
    }

    /** Start capture. Returns false when permission or hardware is unavailable. */
    public boolean start() {
        synchronized (sessionLock) {
            Session current = session;
            if (current != null && current.running) return true;
            if (!hasPermission()) {
                Log.w(TAG, "RECORD_AUDIO not granted");
                return false;
            }

            int min = AudioRecord.getMinBufferSize(
                    SAMPLE_RATE, AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT);
            if (min <= 0) min = SAMPLE_RATE * 2;
            int bufBytes = Math.max(min * 2, 16000);
            final AudioRecord record;
            try {
                record = new AudioRecord(
                        MediaRecorder.AudioSource.MIC, SAMPLE_RATE,
                        AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT,
                        bufBytes);
            } catch (Throwable t) {
                Log.e(TAG, "AudioRecord init", t);
                return false;
            }
            if (record.getState() != AudioRecord.STATE_INITIALIZED) {
                Log.e(TAG, "AudioRecord not initialized");
                try { record.release(); } catch (Throwable ignored) {}
                return false;
            }

            final Session created = new Session(record);
            session = created;
            try {
                record.startRecording();
            } catch (Throwable t) {
                Log.e(TAG, "startRecording", t);
                created.running = false;
                if (session == created) session = null;
                try { record.release(); } catch (Throwable ignored) {}
                return false;
            }

            Thread thread = new Thread(() -> captureLoop(created), "vani-audio-capture");
            created.thread = thread;
            thread.setDaemon(true);
            try { thread.start(); }
            catch (Throwable t) {
                Log.e(TAG, "capture thread start", t);
                created.running = false;
                if (session == created) session = null;
                try { record.stop(); } catch (Throwable ignored) {}
                try { record.release(); } catch (Throwable ignored) {}
                return false;
            }
            Log.i(TAG, "native mic capture started (16kHz mono PCM16)");
            return true;
        }
    }

    private void captureLoop(Session s) {
        short[] pcm = new short[1600];       // 100 ms at 16 kHz
        float[] floats = new float[1600];
        android.os.Process.setThreadPriority(android.os.Process.THREAD_PRIORITY_AUDIO);
        try {
            while (s.running) {
                final int n;
                try {
                    n = s.record.read(pcm, 0, pcm.length);
                } catch (Throwable t) {
                    if (s.running) Log.e(TAG, "AudioRecord read", t);
                    break;
                }
                if (n < 0) {
                    if (s.running) Log.w(TAG, "AudioRecord read error " + n);
                    break;
                }
                if (n == 0) {
                    try { Thread.sleep(8); }
                    catch (InterruptedException e) {
                        Thread.currentThread().interrupt();
                        break;
                    }
                    continue;
                }
                if (!s.running) break;
                for (int i = 0; i < n; i++) floats[i] = pcm[i] / 32768.0f;
                try {
                    // The buffer is reused after this synchronous, bounded VAD
                    // callback. Expensive ASR decoding is dispatched separately.
                    sink.accept(floats, n);
                } catch (Throwable t) {
                    Log.e(TAG, "audio sink failed; closing capture session", t);
                    break;
                }
            }
        } finally {
            s.running = false;
            // Release only after the reader has exited its native read path.
            try { s.record.release(); } catch (Throwable t) { Log.w(TAG, "AudioRecord release", t); }
            synchronized (sessionLock) {
                if (session == s) session = null;
            }
        }
    }

    /** Stop capture without racing a native read against release(). */
    public void stop() {
        final Session s;
        synchronized (sessionLock) {
            s = session;
            if (s == null) return;
            s.running = false;
        }
        try { s.record.stop(); } catch (Throwable ignored) {}
        Thread t = s.thread;
        boolean waited = false;
        if (t != null) {
            t.interrupt();
            boolean onMain = android.os.Looper.myLooper() == android.os.Looper.getMainLooper();
            if (!onMain && t != Thread.currentThread()) {
                waited = true;
                try { t.join(1000); }
                catch (InterruptedException e) {
                    Thread.currentThread().interrupt();
                }
            }
        }
        // If a driver remains stuck, the capture thread still owns release;
        // a new session cannot reuse its recorder or running flag.
        if (waited && t != null && t.isAlive()) Log.w(TAG, "capture thread did not exit within 1000 ms");
    }
}
