// joern-taint.sc —— Joern 污点传播模板：把 Joern 从交互式 REPL 变成 CLI 一把出结果。
//
// 用法:
//   joern-parse -o /workspace/out/target.cpg.bin /workspace/<目标项目>/
//   joern --script /opt/zhishi/joern-taint.sc --params cpgFile=/workspace/out/target.cpg.bin
//
// 改法:按目标语言/bug_class 改 sources / sinks 两组名单,其余不动。
// 结果打 stdout（文本,LLM 友好）；要落盘就 shell 重定向。

import io.joern.dataflowengineoss.language._
import io.joern.dataflowengineoss.queryengine.EngineContext

@main def exec(cpgFile: String): Unit = {
  val cpg = importCpg(cpgFile).get
  implicit val context: EngineContext = EngineContext()

  // 不可信输入入口（source）——按目标语言/入口形态补
  def sources = cpg.call.name("(?i)(read|recv|recvfrom|scanf|gets|fgets|getenv|fread|readline|input|getservbyname)").argument

  // 危险汇聚点（sink）——按 bug_class 补（命令执行/内存破坏/分配释放）
  def sinks = cpg.call.name("(?i)(system|popen|execlp?|execvp?|strcpy|strcat|sprintf|vsprintf|memcpy|free|malloc)").argument

  val flows = sinks.reachableByFlows(sources)
  if (flows.isEmpty) {
    println("[joern-taint] no source→sink flows found")
  } else {
    println(s"[joern-taint] ${flows.size} flow(s):")
    flows.p.foreach(println)
  }
  cpg.close()
}
