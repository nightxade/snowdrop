export { SignalCliBackend, type SignalCliBackendOptions } from './SignalCliBackend';
export { SignalCliError, isSignalCliError, type SignalCliErrorKind } from './errors';
export { HttpTransport, type HttpTransportOptions } from './httpTransport';
export type {
  EventStreamState,
  EventSubscription,
  EventSubscriptionOptions,
  FetchLike,
  RpcParams,
  RpcReply,
  SignalCliTransport,
  TransportCallOptions,
  TransportEvent,
} from './transport';
export { probeDaemon, probeTransport, type ProbeResult } from './probe';
// The decoder toolkit is generic (not signal-cli-specific); other transports
// (src/platform/tauri) reuse it to validate their own IPC replies at the
// boundary, the same way this adapter validates daemon JSON.
export {
  array,
  bool,
  decode,
  isRecord,
  maybe,
  num,
  object,
  oneOf,
  opt,
  str,
  withDefault,
  type DecodeResult,
  type Decoder,
} from './validate';
