/**
 * Map internal voice error codes to calm, user-facing messages. Raw provider/Node
 * errors ("Invalid WebSocket frame: FIN must be set", WS_ERR_EXPECTED_FIN, …) must
 * never reach the red error box; they stay in server logs only.
 *
 * The single mapper for both voice paths: the WebSocket gateway (server.mts) and the
 * record-then-upload route (/api/voice/transcribe).
 */
export function friendlyVoiceError(code: string | undefined): string {
  switch (code) {
    case "AUTHENTICATION_ERROR":
    case "NO_API_KEY":
    case "QUOTA_EXCEEDED":
      return "Voice transcription is temporarily unavailable. Please type your sale instead.";
    case "AUDIO_TOO_LONG":
    case "TOO_LONG":
    case "SESSION_TIME_LIMIT_EXCEEDED":
      return "That recording is a bit long — please keep it under a minute, or type the details.";
    case "EMPTY_RECORDING":
    case "TOO_SHORT":
      return "We couldn't hear anything. Please record again or type the details.";
    case "INSUFFICIENT_AUDIO_ACTIVITY":
      return "We didn't hear any speech. Move closer to the microphone and record again, or type the details.";
    case "FALLBACK_FAILED":
    case "FILE_TIMEOUT":
    case "FILE_NETWORK":
    case "RESOURCE_EXHAUSTED":
      return "We couldn't process that recording. Please record again or type the details.";
    default:
      // Any streaming transport error (WS_ERR_EXPECTED_FIN/SOCKET_ERROR/CLOSED_EARLY/
      // timeouts) that also failed to recover.
      return "We had trouble with the recording. Please record again or type the details.";
  }
}
