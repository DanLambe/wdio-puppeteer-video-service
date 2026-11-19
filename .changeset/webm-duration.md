---
'wdio-puppeteer-video-service': patch
---

WebM recordings now carry their length and a seek index. Before, a kept WebM that was not merged or transcoded had neither, so video players and the HTML report could not show how long a recording was, and the scrub bar could not seek to a point in proportion to its length. FFmpeg now writes each recording file itself, which fixes both.
