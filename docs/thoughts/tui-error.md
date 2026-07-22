I just saw this in the middle of a session:

file:///home/anton/.treehouse/clauctl-90dce5/2/clauctl/dist/tui/transcript.js:89
live.component.updateContent(live.state.partial);─────────────────────────────────────
^
⏵⏵ auto mode on 71k (35%) • claude-fable-5 • medium
TypeError: Cannot read properties of undefined (reading 'partial')
at TranscriptRenderer.append (file:///home/anton/.treehouse/clauctl-90dce5/2/clauctl/dist/tui/transcript.js:89:61)
at InteractiveMode.handleSdkMessage (file:///home/anton/.treehouse/clauctl-90dce5/2/clauctl/dist/tui/interactive-mode.js:379:25)
at InteractiveMode.handleEvent (file:///home/anton/.treehouse/clauctl-90dce5/2/clauctl/dist/tui/interactive-mode.js:348:22)
at handleEvent (file:///home/anton/.treehouse/clauctl-90dce5/2/clauctl/dist/tui/interactive-mode.js:79:46)
at SdkSocketClient.onEvent (file:///home/anton/.treehouse/clauctl-90dce5/2/clauctl/dist/tui/interactive-mode.js:76:57)
at SdkSocketClient.dispatchLine (file:///home/anton/.treehouse/clauctl-90dce5/2/clauctl/dist/core/sdk-socket.js:156:27)
at Socket.<anonymous> (file:///home/anton/.treehouse/clauctl-90dce5/2/clauctl/dist/core/sdk-socket.js:131:32)
at Socket.emit (node:events:507:28)
at addChunk (node:internal/streams/readable:559:12)
at readableAddChunkPushByteMode (node:internal/streams/readable:510:3)

Node.js v23.11.1

history fetch failed: TypeError: entries is not iterable
