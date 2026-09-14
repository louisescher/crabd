---
'@crabd/core': minor
'@crabd/action': minor
---

Improves what a run's log tells you. Every `bash` call logs the command it ran, every file tool logs the path it touched, and the model's reasoning goes into a collapsed group under the turn it belongs to. The full argument object stays behind `CRABD_VERBOSE`, where file contents belong.

Adds a reporter on its own thread. A heap that climbs to the V8 ceiling inside one synchronous step blocks the event loop, which is where the in-process watchdog lives, so the log used to end on whatever line came before the crash. The reporter writes through that window and names the memory in use and the tool call that was running.

Adds a node diagnostic report to the container, read by the post step. A run that aborts is reported as out of memory, with the heap in use and the ceiling it hit, in both the log and the tracking comment. Set `CRABD_REPORT_DIR` to move the file.

Adds a comment when a run dies. Editing the tracking comment notifies nobody, so a crash or a cancel now also leaves a short comment addressed to whoever triggered the run: a threaded reply when an inline review comment set it off, a comment on the pull request otherwise.

Changes the default heap ceiling to 6144 MB, and stops the container writing a core dump. A multi-gigabyte core kept one crashed job running for two and a half minutes after it had already died.
