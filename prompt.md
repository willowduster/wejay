online platform that mimics serato that allows multiple djs (up to 4) to connect up to 2 decks each into one 'serato' window in a shared browser session.
low latency audio with near-lossless is the golden standard and should be the primary feature
support for controllers of all kinds, serato, hercules, rane, pioneer, numark, traktor, and anything else
the user experience shoudl allow login support for google and manual account
no audio files should be stored on the server, just the transit audio data while buffering
backend in golang
frontend in modern js
redis databse cache layer
network compression for low latency

dj features:
3 color waveforms
audio is from client device
waveforms generated realtime

user experience:
sign up
create or pick "room"
room owner can allow or disallow new djs entering
sharable codes for joining room
no sign up to join from link
