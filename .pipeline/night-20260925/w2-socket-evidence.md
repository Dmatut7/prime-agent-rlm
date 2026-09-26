# W2 单实例 daemon socket · 证据索引（父会话代收验，2026-09-25 夜）
子代理 sub-e73276f5 二次死亡（completed_without_reply，2 commit 已落、6 文件裸着未提交未推）。父会话验后收线。
- [E1] 症状真源：S1 roster 碎片（live-threads.json 2条 vs 实际4会话，本会话 08:02 实测）；S2 多世代各占 socket（daemon.sock.<gen>.log 多文件）；S3 launchd daemon last exit 0 空转（launchctl print 实测 PID '-'）。
- [E2] 根因代码位：daemon-socket.ts defaultDaemonSocketDir() 每世代独立目录（设计节引行号 282-284）。
- [E3] 设计节：w2-design.md（6.5KB，含 GitHub prior art 与 adopt/build 判定表，硬闸口齐）。
- [E4] 测试：daemon-socket/daemon-stop-convergence/daemon-supervisor-ownership 三文件 27/27 绿（父会话实跑，含裸改动）。
- [E5] commits：32a9a5adc（live-threads 镜像）、157af45d9（设计节）、+ 收线 commit（single-writer ownership）。
- [E6] 裸改动文件面：3 源+3 测试，无禁碰项（package-lock 未动）。
