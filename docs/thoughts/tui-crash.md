I was just running
clauctl _tui --sdk-socket ~/.local/share/clauctl/383702e1-76c6-4684-8dd2-27efde5f28db/sdk.sock

and it crashed like this:

────────────────────────────────────────────────────────────────────────────────────────────────
file:///home/anton/git/geraschenko/clauctl/dist/tui/interactive-mode.js:282
                    live.component.updateContent(live.state.partial);───────────────────────────
                                                            ^   auto • claude-fable-5 • eee6f052

TypeError: Cannot read properties of undefined (reading 'partial')
    at InteractiveMode.handleSdkMessage (file:///home/anton/git/geraschenko/clauctl/dist/tui/interactive-mode.js:282:61)
    at InteractiveMode.handleEvent (file:///home/anton/git/geraschenko/clauctl/dist/tui/interactive-mode.js:263:22)
    at handleEvent (file:///home/anton/git/geraschenko/clauctl/dist/tui/interactive-mode.js:72:46)
    at SdkSocketClient.onEvent (file:///home/anton/git/geraschenko/clauctl/dist/tui/interactive-mode.js:69:61)
    at SdkSocketClient.dispatchLine (file:///home/anton/git/geraschenko/clauctl/dist/core/sdk-socket.js:96:27)
    at Socket.<anonymous> (file:///home/anton/git/geraschenko/clauctl/dist/core/sdk-socket.js:71:32)
    at Socket.emit (node:events:507:28)
    at addChunk (node:internal/streams/readable:559:12)
    at readableAddChunkPushByteMode (node:internal/streams/readable:510:3)
    at Readable.push (node:internal/streams/readable:390:5)

Node.js v23.11.1
