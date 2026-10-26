/**
 * The real microphone plumbing for the recorder: `getUserMedia` and a Web
 * Audio graph whose worklet (public/voice-capture-worklet.js) hands over the
 * samples. Nothing here runs until someone starts a recording.
 */
import type { CaptureSession } from './recorder';

const WORKLET_NAME = 'snowdrop-voice-capture';
/** How long a context may take to start running before the recording is given up on. */
const RESUME_TIMEOUT_MS = 3000;

/** Asks for the microphone (mono if it can) and nothing else. */
export function openMicrophone(): Promise<MediaStream> {
  // Not there at all when the webview was built without media-stream support.
  const devices = navigator.mediaDevices as MediaDevices | undefined;
  if (!devices || typeof devices.getUserMedia !== 'function')
    return Promise.reject(new DOMException('No media devices', 'NotSupportedError'));
  return devices.getUserMedia({ audio: { channelCount: { ideal: 1 } }, video: false });
}

/**
 * Builds the audio graph right now, in the click that starts recording: a
 * webview only lets an audio context start running when it is made during a
 * user gesture. The worklet module loads in the background; `attach` joins the
 * microphone to it once the permission is in.
 */
export function createWebAudioCapture(): CaptureSession {
  const context = new AudioContext();
  const workletReady = context.audioWorklet.addModule(
    new URL(`${import.meta.env.BASE_URL}voice-capture-worklet.js`, document.baseURI).href,
  );
  // Nobody waits on this until `attach`; a closed context must not report it as unhandled.
  workletReady.catch(() => undefined);
  // The webview starts a context only on a user gesture, and by `attach` (after the
  // permission) the gesture is long gone: ask for it to run now.
  const started: Promise<void> = context.state === 'running' ? Promise.resolve() : context.resume();
  started.catch(() => undefined);

  let onBlock: ((samples: Float32Array) => void) | null = null;
  let pendingFlush: ((samples: Float32Array) => void) | null = null;
  let graph: { source: MediaStreamAudioSourceNode; node: AudioWorkletNode; tap: GainNode } | null =
    null;
  let closed = false;
  // A function, so a state read after an `await` isn't narrowed by one read before it.
  const isClosed = () => closed;
  const running = () => context.state === 'running';

  return {
    sampleRate: context.sampleRate,
    attach: async (stream) => {
      await workletReady;
      if (closed) return;
      const source = context.createMediaStreamSource(stream);
      const node = new AudioWorkletNode(context, WORKLET_NAME, {
        numberOfInputs: 1,
        numberOfOutputs: 1,
        outputChannelCount: [1],
      });
      // A graph nobody listens to may never be pulled; a silent tap keeps it running.
      const tap = context.createGain();
      tap.gain.value = 0;
      source.connect(node);
      node.connect(tap);
      tap.connect(context.destination);
      graph = { source, node, tap };
      node.port.onmessage = (event: MessageEvent<{ type: string; samples?: Float32Array }>) => {
        const { type, samples } = event.data;
        if (type === 'chunk' && samples) onBlock?.(samples);
        else if (type === 'flushed') {
          const done = pendingFlush;
          pendingFlush = null;
          done?.(samples ?? new Float32Array(0));
        }
      };
      if (!running()) {
        await Promise.race([
          started,
          new Promise<void>((resolve) => setTimeout(resolve, RESUME_TIMEOUT_MS)),
        ]);
        // A context that will not run records silence: say so instead.
        if (!isClosed() && !running()) throw new Error('The audio context is not running');
      }
    },
    start: (callback) => {
      onBlock = callback;
    },
    flush: () => {
      const port = graph?.node.port;
      if (closed || !port) return Promise.resolve(new Float32Array(0));
      return new Promise((resolve) => {
        pendingFlush = resolve;
        port.postMessage({ type: 'flush' });
      });
    },
    close: () => {
      if (closed) return;
      closed = true;
      onBlock = null;
      // A flush still waiting is answered empty rather than left hanging.
      pendingFlush?.(new Float32Array(0));
      pendingFlush = null;
      if (graph) {
        graph.node.port.onmessage = null;
        graph.source.disconnect();
        graph.node.disconnect();
        graph.tap.disconnect();
        graph = null;
      }
      void context.close().catch(() => undefined);
    },
  };
}
