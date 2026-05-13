# vhs tape for the baf demo GIF.
#   brew install vhs
#   vhs docs/demo.tape   # writes docs/demo.gif
#
# The script intentionally types `baf` and then quits with `baf-quit`
# so the recording shows the full call → mirror → leave loop.

Output docs/demo.gif

Set FontSize 16
Set Width 960
Set Height 560
Set Theme "Dracula"
Set TypingSpeed 60ms
Set PlaybackSpeed 1.0

Type "baf"
Sleep 400ms
Enter
Sleep 2500ms

# Pretend the user is using the mirrored shell for a moment.
Type "echo hello from your laptop"
Sleep 300ms
Enter
Sleep 1200ms

Type "ls"
Sleep 300ms
Enter
Sleep 1500ms

# Quit baf the discoverable way.
Type "baf-quit"
Sleep 300ms
Enter
Sleep 1000ms
