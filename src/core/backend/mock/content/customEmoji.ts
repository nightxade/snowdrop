/**
 * Two tiny PNG emoji the demo's peers "deliver" with a message (see
 * `ScriptedMessage.customEmoji`), so adding someone's custom emoji can be
 * tried without a patched signal-cli. Same name, different image: the second
 * one clashes with the first once the first is in the collection.
 */
export const MOCK_EMOJI_NAME = 'partyblob';

export const MOCK_EMOJI_PNG = {
  sunny:
    'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAADAAAAAwCAYAAABXAvmHAAAA4UlEQVR42u2a3Q2AMAiEHcIhHEK3dy99M8YYAxxSuEDSxyb3lZbw02lqI7JDaCVFp4M5nG288H3TrREgsGghTMype4n/8EjuU4/wRrh4b4gh4l8g6olHIVKIRyBKA6QSb4FIJ/4B4Xr66zJfSytIvVfiBQ3AXYAWwrRXBfCXCHTvFwByfaIBXiEs0Sf0DfwBkCqcNkADNIAtCqGiOgrRAKTORKUZKeoFyX02vxvvbFSbHiBph6qoKV3QUJSU3ZXo3hBLd869N1qxuVu+vU4x4KAYMdEM+SjGrDSDbpqvBm2gnXxt52/k3IzVAAAAAElFTkSuQmCC',
  sky: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAADAAAAAwCAYAAABXAvmHAAAA40lEQVR42u2a3Q2AMAiEHcIhHMcJHNAl9c0YYwxwSOECSR+b3Fdawk+nqY3IDqGVFJ0O5nC24cK3XbeGgKCipTAhp+4l/ssjqU89xBvR4t0hRoh/gygnHobIIB6CKA2QSbwJIpv4J4Tr6c/Lei2tIO1ekRc0AHcBWgjLXhXAXyLQvZ8AyPWJBniFsESfyDfwC0CqcNoADdAAtiiEiuooRAOQORMVZ6SoFyT32fpu3LNRbXqApB2qoqZ0QUNRUnZXontDJN05995oyeZu+fY6xYCDYsREM+SjGLPSDLppvhq0gXYCe+kKgqoYhoEAAAAASUVORK5CYII=',
} as const;

export type MockEmojiKind = keyof typeof MOCK_EMOJI_PNG;
