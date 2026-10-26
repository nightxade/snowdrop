// Runs on the audio rendering thread: hands the microphone's samples to the
// page in blocks (about 90 ms at 44.1 kHz). The page encodes them; this file
// stays tiny and plain JavaScript because worklet modules are not bundled.
const BLOCK = 4096;

class VoiceCapture extends AudioWorkletProcessor {
  constructor() {
    super();
    this.block = new Float32Array(BLOCK);
    this.filled = 0;
    this.port.onmessage = (event) => {
      if (event.data && event.data.type === 'flush') {
        const rest = this.block.slice(0, this.filled);
        this.filled = 0;
        this.port.postMessage({ type: 'flushed', samples: rest }, [rest.buffer]);
      }
    };
  }

  process(inputs) {
    const channel = inputs[0] && inputs[0][0];
    if (channel) {
      for (let i = 0; i < channel.length; i++) {
        this.block[this.filled++] = channel[i];
        if (this.filled === BLOCK) {
          const full = this.block.slice();
          this.filled = 0;
          this.port.postMessage({ type: 'chunk', samples: full }, [full.buffer]);
        }
      }
    }
    return true;
  }
}

registerProcessor('snowdrop-voice-capture', VoiceCapture);
