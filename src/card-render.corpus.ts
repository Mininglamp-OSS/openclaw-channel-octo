/**
 * 摘要管线的形状语料 —— 四轮评审里**被点过名的每一个输入**,连同它当前的渲染结果。
 *
 * 为什么是一张表而不是散落的断言:这条分支上反复出现同一种失败 —— 为了修一条 finding 而调紧
 * 或调松一个字符类/前瞻/终止符,在另一个方向开了一个更大的口子,而现有测试全绿。逐条打补丁看
 * 不出这种事,因为每条补丁只带来它自己那一条断言。
 *
 * 这张表把「改了这个正则会不会碰坏别的」从判断题变成跑一次测试:任何一处改动,这里会精确列出
 * 哪些行变了、变成了什么。**期望值不是"应该是什么",而是"现在是什么"** —— 它是行为快照,不是
 * 规范。改动让某一行变了,那不一定是 bug,但必须是有意的:改期望值的同时要能说出为什么。
 *
 * 分组即判据,各自的失败方向不同:
 *   - LEAK    凭据必须**不出现**在渲染结果里。这一组变红一律是 bug。
 *   - BENIGN  普通内容不该被误伤成空白。变红是过度隐藏,方向安全但要知情。
 *   - COST    本 PR **刻意**打空的内容,期望值就是空。每行标注 main 的输出,代价才有面。
 *   - REWRITE 归约改写了内容。**渲染结果里的每个字符都必须来自输入**(scheme 前缀除外)——
 *             凭空造串是本模块声明的最坏失败模式:输出看起来像脱敏过的,操作者却无从知道
 *             自己读到的是被改过的。
 *   - UNFIXED 本 PR 未改变其行为的形状。期望值 = main 的行为。
 *   - PERF    耗时上限。这些函数都在同步路径上、无 try/catch。
 */

/** 一行语料。`note` 说明这一行是哪一轮评审点出来的、为什么留在这里。 */
export interface CorpusRow {
  input: string;
  /** 各策略下的渲染结果。缺省的键表示该策略不适用/未固定。 */
  expect: Partial<Record<"grep" | "read" | "exec" | "fetch", string>>;
  note: string;
}

/** 凭据必须不出现在结果里。 */
export const LEAK_CORPUS: CorpusRow[] = [
  // R8:归约够不着、守卫也认不出的那四种 userinfo 形状。它们在 main 上是明文泄漏,此前挂在
  // UNFIXED 组里。关掉它们是**方向性的选择**:评审两轮证明,只要这四种形状还在,「渲染的永远
  // 只有 kept,而 kept 自己要过守卫」这句话就是假的,而尾部扫描的界建立在这句话上 ——
  // 于是界放在 4000 还是 131072 都会漏,只是价钱不同。第四次收窄不如把前提修了。
  {
    input: "user:hunter2@localhost",
    expect: { grep: "https://localhost" },
    note: "R8:裸单标签主机的 DSN。归约此前要求带点,一趟都不匹配",
  },
  {
    input: "/user:pass@localhost",
    expect: { grep: "/https://localhost" },
    note: "R8:前导 `/`",
  },
  {
    input: "prefix/user:pa/ss@db.example.com",
    expect: { grep: "prefix/https://example.com" },
    note: "R8:主机带点,但口令里的 `/` 让归约此前的 `[^\\s/]+` 匹配不上",
  },
  {
    // R9:`host:` 后面跟非数字,是 DSN 在错误串里最常见的写法。上一版前瞻把 `:` 一律排除,
    // 于是这条整个匹配不上、口令原样渲染 —— 而排除 `:` 的理由(docker 摘要)现在由
    // `(?!:\d)` 精确表达:`sha256:1234` 是冒号接数字,`localhost: refused` 不是。
    input: "connect to user:hunter2@localhost: refused",
    expect: { grep: "connect to https://localhost: refused" },
    note: "R9:主机后带冒号的 DSN。前瞻排除 `:` 时这条不归约,口令明文渲染",
  },
  {
    input: "user:hunter2@[::1]",
    expect: { grep: "https://[::1]" },
    note: "R8:IPv6 方括号主机。按 `:` 切主机会切成 `[`,整行被打空 —— 现在取到 `]` 为止",
  },
  {
    // R7:收窄尾部扫描时漏掉的那个前提。守卫抓不住单标签 userinfo(此前在 UNFIXED 组),
    // 当时压住整串的只有 4000 字符之外那个 `token` —— 把整个守卫收进 TAIL_SCAN_MAX 之后,
    // 这三个 sink 全部渲染出明文口令。现在只有 JWT 那一档收窄,关键词档看完整条尾巴。
    input: "alice:hunter2@localhost " + "word ".repeat(900) + "pad ".repeat(1300) + " token",
    expect: { grep: "", read: "", exec: "" },
    note: "R7:切口之外的关键词必须仍然压得住 kept 里守卫认不出的凭据",
  },
  // R8:上面那一行只钉住了「关键词落在窗口外」这一种,而它恰好是当时已经过了的那一种。
  // 下面两行是评审第三轮实际复现的两个形状 —— 收窄一次它们就复活一次,所以必须各自有一行。
  // 注意期望值**不是空串**:前缀被归约成 `https://localhost` 之后,后面的普通词照常渲染。
  // 判据不是「整串扣下」,是「口令不出现」—— 这一组的造串检测与 LEAK 的子串检测都盯着它。
  //
  // 两条期望值是**实测粘贴**的,不是手算的。手算这种字面量我在这条分支上已经错了三次
  // (COST 组的 mainRenders 两次、这里一次),每次都是差一两个字符 —— 它们看着像是能推出来的,
  // 而 SUMMARY_MAX 截断落在哪个词中间取决于前缀长度,推错了测试还会绿着接受一个错的真相。
  {
    input: "alice:hunter2@localhost " + "word ".repeat(900) + "pad ".repeat(1300) + "eyJabcdefgh.abcdefgh.abc",
    expect: {
      grep: "https://localhost word word word word word word word word word w…",
      read: "https://localhost word word word word word word word word word w…",
      exec: "",
    },
    note: "R8-P0:短的低熵 JWT 落在 TAIL_SCAN_MAX 之外 —— 熵检测看不见它,JWT_RE 够不着它",
  },
  {
    input: "alice:hunter2@localhost " + "word ".repeat(900) + "pad ".repeat(33_000) + " token",
    expect: {
      grep: "https://localhost word word word word word word word word word w…",
      read: "https://localhost word word word word word word word word word w…",
      exec: "",
    },
    note: "R8-P1:关键词落在线性档 RAW_INPUT_MAX 触及范围之外(136 KB)",
  },
  {
    input: "PASSPHRASE='correct horse battery staple' gpg --sign x",
    expect: { exec: "gpg" },
    note: "R3:空白分词把带引号的多词值切碎,程序名落在值的第二个词上 → main 渲染 `horse`",
  },
  {
    input: "MY_CREDS='alpha hunter2 charlie' ./go",
    expect: { exec: "./go" },
    note: "R3:同上,main 渲染 `hunter2`",
  },
  {
    input: 'DEPLOY_KEY="one s3cr3tvalue two" ./deploy.sh',
    expect: { exec: "./deploy.sh" },
    note: "R3:双引号形态,main 渲染 `s3cr3tvalue`",
  },
  {
    input: "MY_CREDS=$'alpha hunter2 x' ./go",
    expect: { exec: "./go" },
    note: "R3:ANSI-C 引用。词原子必须写成**重复**而非单选,否则引号只在 `=` 后第 0 位生效",
  },
  {
    input: 'PASSPHRASE="alpha\\" hunter2 x" gpg',
    expect: { exec: "gpg" },
    note: "R3:值里有转义引号,不能在转义处提前收尾",
  },
  // 截断附近的凭据。**这一类此前一行都没有** —— PERF 组只测了截断的耗时,没有任何一组测
  // 「截断对切口附近的凭据做了什么」,所以一条盲切引入的明文泄漏全绿通过了两个 reviewer。
  {
    input: "alice:" + "h".repeat(3995) + "@db.example.com",
    expect: { grep: "", read: "", exec: "" },
    note: "R5-P0:盲切会切在口令与 `@host` 之间,归约失去锚点 → main `https://example.com`,盲切 `alice:hhhh…`。口令长时存活前缀从 offset 0 开始,64/120 的渲染上限挡不住",
  },
  {
    input: "user:" + "abcdefghij".repeat(400) + "@db.example.com",
    expect: { grep: "", read: "", exec: "" },
    note: "R5-P0:同上,另一种口令构成",
  },
  {
    input: "z".repeat(3985) + " user:hunter2@db.example.com/prod",
    expect: { grep: "z".repeat(64) + "…", read: "z".repeat(64) + "…" },
    note: "R5-P0:切口落在 DSN 之前的那个空格上,DSN 整个在保留段之外 → 被丢掉,不是被切开。盲切会把它切成 `user:hunter2@d` 渲染出去",
  },
  {
    input: "z".repeat(3990) + " AKIAIOSFODNN7EXAMPLE",
    expect: { grep: "", read: "" },
    note: "R4:横跨切口的密钥。盲切时渲染成 `…AKIAIOSFO`。R6 起整串扣下而不是渲染安全前缀 —— 界会把丢掉的那一段过一遍调用方自己的守卫,**与 main 的判定一致**(main 无界,守卫看到 AKIA,同样扣下)。exec 不列:shell 策略只取程序名,密钥在第二个 token 上",
  },
  // R6-P0:界删掉的不只是字符,还可能是**正在压住一个凭据的那个关键词**。守卫读的是截断后的
  // 串,所以尾部的 `token`/`password` 被切掉之后,剩下的部分在守卫眼里是干净的。凭据在
  // offset 0,摘要 64 / 错误 120 的上限一个都挡不住。修法见 boundedForReduction。
  {
    input: "user:hunter2@localhost " + "x ".repeat(1988) + "y token",
    expect: { grep: "", read: "" },
    note: "R6-P0:尾部关键词被界删掉 → main `\"\"`,修复前 head 渲染 `user:hunter2@localhost x x x…`",
  },
  {
    input: "user:hunter2@localhost " + "x ".repeat(1988) + "y password",
    expect: { grep: "", read: "" },
    note: "R6-P0:同上,`password` 作触发词",
  },
  {
    input: "/user:hunter2@localhost " + "x ".repeat(1988) + "y token",
    expect: { grep: "", read: "" },
    note: "R6-P0:前导 `/` 的 DSN(UNFIXED 那一类),同一成因",
  },
  {
    input: "user:hunter2@localhost " + "x ".repeat(1988) + "y AKIAIOSFODNN7EXAMPLE",
    expect: { grep: "", read: "" },
    note: "R6-P0:尾部是**明确前缀**凭据而非关键词,SECRET_PREFIX_RES 这一路同样被界删掉",
  },
  {
    input: "user:hunter2@localhost " + "x ".repeat(1988) + "y aB3dE7gH1jK4mN8pQ2rS5tU9vW6xY0zA",
    expect: { grep: "" },
    note: "R6-P0:尾部是**纯高熵**串(无关键词、无前缀),只有 generic=true 的调用方抓得到。read 在 main 上同样渲染,故不列 —— 与 BENIGN 那条 git SHA 行合起来钉住「谓词必须来自调用方」",
  },
  // R6-P1:赋值折叠改变了**选中哪个 token**,而选中的那个是原样渲染的。main 上空白分词把带
  // 引号的值切碎,候选停在 `b'` 上、被形状校验挡下;折叠修好分词后,搜索多走一个 token,
  // 正好落到 DSN 上。见 DSN_SHAPED_TOKEN_RE。
  {
    input: "X='a b' user:hunter2@localhost",
    expect: { exec: "" },
    note: "R6-P1:main `\"\"`(候选是 `b'`,带引号被挡),修复前 head 渲染 `user:hunter2@localhost`",
  },
  {
    input: 'X="a b" user:hunter2@localhost',
    expect: { exec: "" },
    note: "R6-P1:双引号形态",
  },
  {
    input: "X=$'a b' user:hunter2@localhost",
    expect: { exec: "" },
    note: "R6-P1:ANSI-C 引用形态",
  },
  {
    input: "A='p q' B='r s' user:hunter2@localhost",
    expect: { exec: "" },
    note: "R6-P1:多个赋值,跳过循环走得更远",
  },
  {
    input: "X='a b' user:hun/ter2@db.example.com",
    expect: { exec: "" },
    note: "R6-P1:主机带点、但口令含 `/`,归约的 `[^\\s/]+` 匹配不上,所以归约救不回来",
  },
  // 子代理评审(R6 推送前)找出的那一类:**用户名里带 `@`**。第一版守卫写成正则
  // `[^@]*:[^@]*@`,`[^@]*` 跨不过 `@`,于是它按**第一个** `@` 判定,而 pass 3 按最后一个。
  // 两条规则一分岔,Azure SQL / MongoDB Atlas / Snowflake 那套 email-username DSN 整类走过去。
  {
    input: "X='a b' alice@corp.com:hunter2@localhost",
    expect: { exec: "" },
    note: "R6-审:用户名含 `@`。main `\"\"`,第一版守卫渲染 `alice@corp.com:hunter2@localhost`",
  },
  {
    input: "X='a b' alice@corp:hunter2@postgres",
    expect: { exec: "" },
    note: "R6-审:同上,单标签主机",
  },
  {
    input: "X='a b' alice@corp.com:p/w@db.example.com",
    expect: { exec: "" },
    note: "R6-审:用户名含 `@` **且**口令含 `/` —— 上一行只覆盖了这一类的一半",
  },
  {
    input: "X='a b' @alice:hunter2@localhost",
    expect: { exec: "" },
    note: "R6-审:`@` 就在开头",
  },
  {
    input: "X='a b' user:hun@ter2@db.example.com",
    expect: { exec: "" },
    note: "R6-审:`@` 在**口令**里(第一版就挡住了)。留着是因为它和上面几行合起来钉住「按最后一个 `@`」这条规则本身",
  },
  {
    input: "https://hooks.slack.com/services/T00/B00/abcdEFGH1234abcdEFGH1234",
    expect: { grep: "https://slack.com", fetch: "https://slack.com" },
    note: "既有:webhook path 即凭据,只暴露注册域",
  },
  {
    input: "https://u:p@host.com/a/b?token=sk-secret&x=1",
    expect: { fetch: "https://host.com" },
    note: "既有:带 scheme 的 DSN 由第 1 趟 new URL() 剥掉 userinfo 与 query",
  },
  // R9/R10:归约把主机小写化(WHATWG),而 AKIA/AIza 探测器大小写敏感 —— 归约会把唯一压着这个
  // 凭据的信号自己毁掉。逐字比对**只比 host、不比整段**,大小写不同即不匹配,这条路断掉。
  // 放在 LEAK(不是 UNFIXED)是因为它是凭据泄漏哨兵:除了逐行等值,本组的大小写不敏感子串
  // 断言也盯着它 —— 上一版只有等值这一道,而子串那道又是大小写敏感的,小写输出照样过。
  {
    input: "a:b@AKIAIOSFODNN7EXAMPLE",
    expect: { grep: "", read: "" },
    note: "R9:new URL() 小写化主机,AKIA 探测器大小写敏感。逐字比对时不匹配,不发",
  },
  {
    // 口令里塞一份小写主机名。逐字比对若比整段 `m`(含 userinfo),口令这份副本就满足它,
    // 上一行那条泄漏原样复活 —— 上一版正是这么漏的,而当时套件分辨不出。必须只比 `host`。
    input: "a:akiaiosfodnn7example@AKIAIOSFODNN7EXAMPLE",
    expect: { grep: "", read: "" },
    note: "R10:口令供给主机名绕过逐字比对。比 host 而非整段 m 才挡得住",
  },
  // R11:评审第六轮的两个 P0/P1 —— 都是「为性能加的界静默削弱了脱敏」,而不是老问题重演。
  {
    // 口令超过 SCHEMELESS_USERINFO_RE 的 256 上限:整条正则匹配不上、DSN 原样流过归约。
    // 上一版这里 fail-open,明文口令在五个群可见 sink 全渲染出来(阈值精确在 257,无长度前提)。
    // hasOverlongUserinfo 补的那道 fail-closed 把它扣下。守卫**抓不住**这个纯字母口令
    // (isSensitive 两档都 false),所以不能靠守卫,必须靠这道超限检测。
    input: "connect failed for alice:" + "correcthorsebatterystaple".repeat(11).slice(0, 275) + "@db.example.com after 3 retries",
    expect: { grep: "", read: "" },
    note: "R11-P0:口令 275 字符 > 256。上一版 fail-open 渲染明文;现在超限即敏感,扣下",
  },
  {
    // 纯数字单标签主机,守卫看不见(不含关键词/前缀/高熵),归约此前也够不着(要求含字母)。
    // 去掉字母要求后它走到逐字比对:`new URL("https://1")` 规范成 `0.0.0.1`,不在输入里 → 删除。
    // 这一条钉住「前提」对这类形状也成立 —— 不然 collapseForReduction 的 128 KiB 触及上限
    // 又会变成泄漏(远处关键词够不着、而近处的 `@1` DSN 守卫认不出)。
    input: "alice:hunter2@1 " + "x ".repeat(80_000) + " token",
    // `@1` 前缀被删,剩下的 `x x x…` 是无害填充,截到 SUMMARY_MAX 加省略号。判据是**口令不出现**
    // (本组的子串断言盯着 `hunter2`);等值这一栏只是把「删掉凭据后剩什么」如实记下。
    expect: { grep: "x ".repeat(32) + "…", read: "x ".repeat(32) + "…" },
    note: "R11-P1:纯数字单标签 + 128 KiB 外的关键词。去掉字母要求让它走到逐字比对被删",
  },
];

/** 普通内容不该被误伤成空白。 */
export const BENIGN_CORPUS: CorpusRow[] = [
  {
    input: "src/index.ts",
    expect: { read: "src/index.ts", grep: "src/index.ts" },
    note: "R4:普通相对路径。放宽 query 趟的主机形状会把它当 host/path 毁掉",
  },
  {
    input: "src/file?.ts",
    expect: { read: "src/file?.ts", grep: "src/file?.ts" },
    note: "R4:shell glob 不含 `=`,不被 query 趟碰",
  },
  {
    input: "10/20?ok=yes",
    expect: { grep: "10/20?ok=yes" },
    note: "R4:纯数字主机归约主动不碰;兜底也必须不拦,否则 query 策略直接空白卡",
  },
  {
    input: "2026-08-06?ok=yes",
    expect: { grep: "2026-08-06?ok=yes" },
    note: "R4:同上,日期形态",
  },
  {
    input: "8080?code=abc",
    expect: { grep: "8080?code=abc" },
    note: "R4b:裸数字单标签。与上面两行形状一致,无法区分 —— query 剥离那条已移出本分支,这行记录的是移出后的行为",
  },
  {
    input: "email:\\s*\\S+@\\S+",
    expect: { grep: "email:\\s*\\S+@\\S+" },
    note: "R4c:搜邮箱是常规操作。曾被 userinfo 兜底整串打空",
  },
  {
    input: "sed 's:a:b@c:g'",
    expect: { exec: "sed" },
    note: "既有:与 DSN 形状无法区分,shell 有程序名可退",
  },
  {
    input: "/repo/.git/objects/1a/2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b1c",
    expect: { read: "…/1a/2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b1c" },
    note: "既有:高熵检测不套用到 path,否则日常路径频繁空白",
  },
  {
    input: "risk-averse task-force",
    expect: { grep: "risk-averse task-force" },
    note: "既有:前缀式密钥的长度下限不能误伤连字符英文",
  },
  // R6:**这一行钉住的是「界用的谓词必须来自调用方」。** 被丢掉的尾巴是一个 git SHA;
  // read(generic=false)在 main 上照常渲染,把界里的谓词写死成最严的一档就会把它打空。
  // 与 LEAK 里那条「尾部纯高熵」正好夹住:写死宽的漏那条,写死严的误伤这条。
  {
    input: "word ".repeat(900) + "2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b1c",
    expect: { read: "word ".repeat(12) + "word…" },
    note: "R6:尾部 git SHA 的普通长文本。main 的 read 渲染它、grep 扣下它 —— main 自己就按策略分岔,所以界不能有一个写死的判定",
  },
];

/**
 * **本 PR 刻意付出的可用性代价。** 这些行在 `main` 上有输出,在这里被整块拒绝。
 *
 * 与 BENIGN 的区别:BENIGN 变红是"过度隐藏,方向安全但要知情",这一组**本来就是隐藏的**,
 * 期望值就是空。它存在的意义是让代价有一个精确的面,而不是一句"超长无空白就不渲染"。
 *
 * 为什么需要单独一组:上一轮这条代价只由 BENIGN 里的一行 `"a"×4100` 记录,而 `"a"` 是十六进制
 * 字符 —— `main` 对它同样返回空(走 isSensitive 的长 hex 分支)。**那一行两边都是空,记录不到
 * 任何差异,空转了一整轮评审。** 下面每一行都标注了 `main` 的输出,一眼能看出差在哪。
 *
 * 最重要的一件事:被拒的不只是"归约不了的怪串",**长 URL 也在里面** —— 而长 URL 恰恰是这条
 * 管线处理得最好的一类(`main` 上 0.2–0.8 ms 归约成注册域)。看起来该把第 1 趟提到界之上,
 * 实测不行,原因写在 `reduceUrlsInText` 的注释里(第 1 趟在无 `://` 时是二次的)。
 *
 * 未列入(expect 只覆盖工具策略):`sanitizeErrorText("failed to fetch " + 4045 字符预签名 URL)`
 * 在 `main` 上是 `failed to fetch https://amazonaws.com`,这里是 `failed to fetch`。
 *
 * **`mainRenders` 是必填的实测值,不是注释。** 上一轮这一组靠三条结构检查(超长、前 4000 无
 * 空白、非纯 hex)来保证"每行都记录到差异",那是**代理不是观测** —— `"token=" + "z"×4100`
 * 三条全过,两边却都是空。把 main 的输出写成字段,再断言它非空,空转的行就写不进来了:
 * 要加一行,得先去 main 上量;量出来是空,就说明这行根本不属于这一组。
 */
export interface CostRow extends CorpusRow {
  /** 同一输入在 `main`(b1e3def)上 grep 策略的实测输出。必须非空 —— 否则这行记录不到代价。 */
  mainRenders: string;
}

export const COST_CORPUS: CostRow[] = [
  {
    input: "https://example.com/" + "z".repeat(4100),
    expect: { grep: "", read: "" },
    mainRenders: "https://example.com",
    note: "R5-P1:超长无空白 URL。main 上第 1 趟线性,0.8 ms 归约成注册域",
  },
  {
    input: "https://s3.amazonaws.com/b/k?X-Amz-Signature=" + "a".repeat(4000),
    expect: { grep: "", read: "" },
    mainRenders: "https://amazonaws.com",
    note: "R5-P1:预签名 URL,现实形状。read 策略在 main 上渲染 65 字符的 path+query",
  },
  {
    input: "z".repeat(4100),
    expect: { grep: "", read: "" },
    mainRenders: "z".repeat(64) + "…",
    note: "R5-P2:空白边界截断的代价本体。**必须用非十六进制字符** —— `\"a\"×4100` 在 main 上也是空(isSensitive 长 hex 分支),那一行空转了整整一轮评审",
  },
  {
    input: "zq".repeat(2050),
    expect: { grep: "", read: "" },
    mainRenders: "zq".repeat(32) + "…",
    note: "R5-P2:同上,展示块形态。main 渲染 4100 字符,这里整块不渲染",
  },
  // R6:界按 **UTF-16 code unit** 计,而 CJK 散文不含 ASCII 空白 —— 一整段中文就是一个不可切
  // 的 token。对中文产品这是真实用户最可能碰到这条拒绝的路径,而「4000 字符」这个说法在这里
  // 不成立:星平面字符每个占 2 units,实际阈值只有一半。
  {
    input: "中".repeat(4100),
    expect: { grep: "", read: "" },
    mainRenders: "中".repeat(64) + "…",
    note: "R6-P1:普通中文长文本。4100 units,无 ASCII 空白 → 整段不渲染",
  },
  // 子代理评审找出的一类,**这一组此前一行都没覆盖**:上面每行都是"无空白长 token",而这一类
  // 空白充裕、切点完全正常,被打空的原因是**尾巴里那条普通链接**。守卫跑在归约之前,看到的是
  // 原文里 ≥32 字符、含 `/` 的路径,而下游那道看到的是归约完的串,根本没有这一段。
  // 明知故犯的取舍,理由写在 boundedForReduction 上方(顺着改会开一个新泄漏)。
  {
    input: "connection refused after 3 retries " + "word ".repeat(900)
      + "see https://docs.example.com/troubleshooting/connection-refused-timeouts",
    expect: { grep: "" },
    mainRenders: "connection refused after 3 retries word word word word word word…",
    note: "R6-审:长错误文本 + 尾部文档链接。**只在 generic 那一侧被打空** —— read(generic=false)不套用高熵检测,两边都渲染,故不列。sanitizeErrorText 也走高熵那一路:main 121 字符,这里空",
  },
  {
    input: "word ".repeat(900) + "https://hooks.slack.com/services/T00/B00/abcdEFGH1234abcdEFGH1234",
    expect: { grep: "" },
    mainRenders: "word ".repeat(12) + "word…",
    note: "R6-审:webhook 在**尾部**。同样内容放在开头时正常渲染(那正是删掉 card-blocks 预检修好的),放尾部则被界的守卫扣下 —— 两个方向都要有行,否则读者以为整类都好了",
  },
  {
    input: "😀".repeat(2001),
    expect: { grep: "", read: "" },
    mainRenders: "😀".repeat(32) + "…",
    note: "R6-P1:星平面字符每个 2 units,所以 **2001 个** emoji 就越界 —— 文档说的「4000 字符」在这里是 2000 个。`\"😀\"×1999`(3998 units)仍正常渲染",
  },
];

/**
 * 归约改写了内容的行。**结果里的每个字符都必须来自输入**(`https://` 前缀除外)。
 * 这一组是给「凭空造串」这一类失败准备的:R4a 里 `nginx:1.21@sha256:1234abcd` 曾被改写成
 * `https://sha256abcd`,`3:4@2/x` 曾被 new URL() 规范化成 `https://0.0.0.2`。
 */
export const REWRITE_CORPUS: CorpusRow[] = [
  // R8:单标签放宽的**误伤**,两条都记在这里而不是悄悄消化掉。方向安全(少渲染)、不造串
  // (输出里每个字符都来自输入),但确实把可读内容改写了。之所以换得起:同样的形状既可能是
  // `user:.*@example` 这样的 grep 模式,也可能是 `user:hunter2@example` 这样的真凭据,
  // 光看形状分不开 —— 任何渲染前者的规则都会渲染后者。
  {
    input: "user:.*@example",
    expect: { grep: "https://example" },
    note: "R8 误伤:搜凭据的 grep 模式被当成 DSN 归约(原 BENIGN 行)",
  },
  {
    input: "image:v1@registry/repo",
    expect: { grep: "https://registry" },
    note: "R8 误伤:docker 风格引用被当成 DSN 归约。仍是造串哨兵 —— `registry` 必须来自输入",
  },
  {
    input: "user:pw@db.example.com:5432/prod",
    expect: { grep: "https://example.com" },
    note: "既有:带点主机的 DSN,main 就是这个行为",
  },
];

/**
 * **本 PR 不修**、留给 userinfo 那条后续 PR 的形状。期望值 = `main` 的行为。
 *
 * 为什么明确列出来而不是省略:这一组是 `SCHEMELESS_USERINFO_RE` 的单标签放宽 + 配套 fail-closed
 * 兜底要覆盖的面。那一对在四轮里两次把缺陷改成了更糟的缺陷 —— 放宽归约会把
 * `nginx:1.21@sha256:1234abcd` 改写成输入里不存在的 `https://sha256abcd`,收紧兜底又会让一个
 * 尾随逗号整条绕过它 —— 所以整对摘出去单独评审了。
 *
 * 但形状必须留在表里:它们同时进造串检测,谁再动那对正则,这里会立刻指出改写方向对不对。
 * 前四行是 `main` 上就存在的明文泄漏,**不是本 PR 引入的**,也不是本 PR 声称修好的。
 */
export const UNFIXED_CORPUS: CorpusRow[] = [
  // (原先这里有四行单标签/IPv6/口令带斜杠的明文泄漏。它们**已经修好**,搬到 LEAK 组了 ——
  //  见那边的 R8 段。留这条注释是因为上面那段说明还在讲这一对正则的历史。)
  // 赋值折叠漏掉的一类:值以 SHELL_BREAK 里的字符开头(`(`、`;`、`|`、`&`、`<`、`>`、反引号)。
  // `(?:SHELL_WORD_ATOM)*` 匹配零个原子,折叠只写出 `NAME=_`,值的其余部分留在串里,跳过循环
  // 又落回值的第二个词 —— 正是折叠这条改动要关的那个失败。
  //
  // **main 上渲染完全相同**,不是本 PR 引入的;本 PR 收窄了这一类而不是扩大它。钉在这里是因为
  // LEAK 组把 `'…'`/`"…"`/`$'…'` 三种钉成已修,不写这几行,读者会以为整类都关了。
  // 修法是有的(折叠后跳过的 token 必须**恰好**是 `NAME=_`,否则整串不渲染),但那是扩范围,
  // 留给独立改动。
  {
    input: "PASSPHRASE=(correct horse battery staple) gpg --sign x",
    expect: { exec: "horse" },
    note: "R5-P2:值以 `(` 开头 → 折叠退化,程序名落在值的第二个词上。main 同样渲染 `horse`",
  },
  {
    input: "MY_CREDS=;alpha hunter2 charlie ./go",
    expect: { exec: "hunter2" },
    note: "R5-P2:值以 `;` 开头,同一成因",
  },
  {
    input: "MY_CREDS=<alpha hunter2 charlie",
    expect: { exec: "hunter2" },
    note: "R5-P2:值以 `<` 开头,同一成因",
  },
  {
    input: "nginx:1.21@sha256:1234abcd",
    expect: { grep: "nginx:1.21@sha256:1234abcd" },
    note: "造串哨兵:放宽单标签分支时曾被改写成 `https://sha256abcd`,输入里没有这个串",
  },
  {
    input: "3:4@2/x",
    expect: { grep: "" },
    note: "R11 造串哨兵:纯数字主机 `2` 曾被 new URL() 规范成 `https://0.0.0.2`。去掉「单标签必须含字母」后它走到逐字比对 —— `0.0.0.2` 不在输入里 → 删除(比渲染原文更安全:不造串也不泄漏)",
  },
  {
    input: "a:b@1.2.3",
    expect: { grep: "" },
    note: "R9 造串哨兵:**带点**分支的同一条 new URL() 路径 —— `1.2.3` 被规范成 `1.2.0.3`。上一版只给无点分支加了「必须含字母」,这条漏在另一边",
  },
  {
    input: "scope:name@1.0.0",
    expect: { grep: "" },
    note: "R9 造串哨兵:普通 npm/maven 坐标,曾被渲染成 `https://1.0.0.0`",
  },
  {
    input: "a:b@0x7f.1",
    expect: { grep: "" },
    note: "R9 造串哨兵:十六进制被 new URL() 展开成 `127.0.0.1`",
  },
];

/**
 * 耗时上限。列在这里的每一个形状都曾经是几秒级停顿。
 *
 * **形状要多样。** 回溯代价随输入形状变化极大,只测一种会得出「另外几趟不要紧」的错误结论 ——
 * 这条分支上犯过两次:一次是只测了 `a:b@` + 无点串就断定 schemeless 那几趟免费,一次是只测了
 * 管线本身、没测冒号密集串,于是一个 5.9 秒的回归全绿通过。
 *
 * **第三次的形式不同,要单独说:** 空白边界截断落地后,超过上限且**前 4000 字符不含空白**的输入
 * 在长度判定处就被拒了,一趟正则都不跑。原来那四行长输入(含 main 上 9–11 秒的三行)于是全部
 * 短路 —— 它们断言的变成了「长度守卫存在」,而不是「那几趟有界」。按本分支自己的数字推算,
 * R4a 那个三次方回归(6000 字符 5877 ms)在 4000 字符处约 1.7 秒,**低于当时 2000 ms 的预算,
 * 会绿着通过**。
 *
 * 所以每一行都标注 `reachesPasses`,并且**这个标注本身被断言** —— 哪天 REDUCE_INPUT_MAX 动了、
 * 某行悄悄滑进短路组,测试会直接红,而不是安静地失去覆盖。带空白的长输入是真正压住那几趟的行。
 */
export interface PerfRow {
  label: string;
  input: string;
  /** 这一行会不会真的进入归约管线(而不是在长度判定处被拒)。测试会核对它与实际是否一致。 */
  reachesPasses: boolean;
  note: string;
}

export const PERF_CORPUS: PerfRow[] = [
  {
    label: "无点长串 + query",
    input: "a".repeat(100_000) + "?x",
    reachesPasses: false,
    note: "R1:main 上 read 策略 9311 ms",
  },
  {
    label: "scheme + 长主机",
    input: "http://" + "a".repeat(120_000),
    reachesPasses: false,
    note: "R1:走第 1 趟 scheme 正则,与上一行代价完全不同",
  },
  {
    label: "userinfo 前缀 + 长串",
    input: "a:b@" + "a".repeat(60_000),
    reachesPasses: false,
    note: "R1:main 上 exec 策略 3442 ms",
  },
  {
    label: "冒号密集(无空白)",
    input: "a:".repeat(3000),
    reachesPasses: false,
    note: "R4a:曾在兜底的无界前瞻上跑出 5877 ms。**串里不能有空白** —— 有空白的 `key: val` 只有 1 ms,回溯长度取决于单个 token",
  },
  {
    label: "冒号密集 + 长尾",
    input: "a:".repeat(1000) + "b".repeat(2000),
    reachesPasses: true,
    note: "R4a:同上,7314 ms",
  },
  {
    label: "压缩 JSON(无空白)",
    input: "{" + Array.from({ length: 180 }, (_, i) => `"k${i}":"v${i}"`).join(",") + "}",
    reachesPasses: true,
    note: "R4a:模型正常会生成的参数,曾 1247 ms。这一行是「不只是构造串」的证据",
  },
  {
    label: "label selector(无空白)",
    input: Array.from({ length: 250 }, (_, i) => `app${i}:v${i}`).join(","),
    reachesPasses: true,
    note: "R4a:同上,曾 1272 ms",
  },
  // 下面四行**带空白**,所以过得了长度判定、真的跑完整条管线。上面那四行短路的只证明守卫在,
  // 这四行才是压住回溯代价的。实测 10–18 ms。
  {
    label: "空白 + 冒号密集",
    input: "x " + "a:".repeat(1999),
    reachesPasses: true,
    note: "R5:与上面「冒号密集(无空白)」同构,但因为有空白而真的进管线。那一行 0.00 ms,这一行 10 ms",
  },
  {
    label: "空白 + 无点长串",
    input: "x " + "a".repeat(3990) + "?y",
    reachesPasses: true,
    note: "R1 那条 9311 ms 形状的可达版本",
  },
  {
    label: "空白 + userinfo 前缀",
    input: "x " + "a:b@" + "a".repeat(3980),
    reachesPasses: true,
    note: "R1 那条 3442 ms 形状的可达版本,实测最贵的一行(17.5 ms)",
  },
  {
    label: "空白 + scheme",
    input: "x http://" + "a".repeat(3980),
    reachesPasses: true,
    note: "R1:走第 1 趟 scheme 正则,与上面几行代价完全不同",
  },
  // 这两行钉住本 PR 的两个上限。加它们是因为对抗评审点出:**修复本身一行都没被钉住** ——
  // 整组里没有任何一行「超过 64 KiB 且含空白」,于是 collapseForReduction 的切口路径零覆盖;
  // 尾部扫描那个二次方也没有一行会在 main 上超时。修复不被自己的语料覆盖,下一次改动就没有红。
  {
    label: "超过 64 KiB 且含空白 —— 折叠切口路径",
    input: "word ".repeat(20_000),
    reachesPasses: true,
    note: "R8:唯一一行会真的走到 collapseForReduction 的空白切口(其余超长行全无空白,长度判定处就短路了)",
  },
  {
    label: "空白 + 64 KiB 无点 base64",
    input: "x " + "eyJ".repeat(21_845),
    // main 上没有这道守卫,它**跑完了**整条管线,实测 426 ms —— 超过本组 300 ms 的预算。
    // 现在切口之后是一整块 65 KB 无空白 token,tailScanWindow fail closed,守卫处就拒了。
    // 标注是 false 正说明修复生效:这一行钉的是"这个形状不再贵",不是"这几趟有界"。
    reachesPasses: false,
    note: "R8:尾部扫描的二次方形状 —— main 426 ms,本分支在守卫处短路,3 ms",
  },
  // 赋值折叠的对抗形状。它此前一行都没有 —— ASSIGNMENT_VALUE_RE / SHELL_WORD_ATOM 是本 PR 新加的
  // 正则,而 `SHELL_WORD_ATOM` 是 `(?:A|B|C|D|E)*` 这种嵌套重复,正是灾难性回溯的经典形状。
  // 这里不回溯的理由是「星号后面没有东西,匹配永远能收尾」,但那是**推理**;这几行把它变成实测。
  //
  // 另一件必须记的事:`summarizeShell` 的折叠跑在**未截断的原串**上 —— 它不经过归约那道界。
  // 所以这几行压住的是 exec 策略自己那条路,不是管线。
  {
    label: "赋值值 + 未闭合单引号",
    input: "x X=" + "'a".repeat(1999),
    reachesPasses: true,
    note: "R5-nit:每个 `'a` 都是一个 `'(?:\\\\.|[^'])*'?` 原子,星号要在 2000 个原子上收敛",
  },
  {
    label: "赋值值 + 未闭合双引号",
    input: "x X=" + '"a'.repeat(1999),
    reachesPasses: true,
    note: "R5-nit:同上,双引号分支",
  },
  {
    label: "赋值值 + 未闭合 $( ",
    input: "x X=" + "$(a".repeat(1332),
    reachesPasses: true,
    note: "R5-nit:命令替换分支,原子内还含一层 `[^)]*`",
  },
  {
    // 子代理评审找出来的:程序名形状校验跑在**归约那道界之上**,所以它自己的正则必须线性。
    // 第一版 `[^@]*:[^@]*@` 在「冒号密集、无 `@`」上是二次的 —— 实测 `":"×131072` 19 077 ms
    // (main 4.3 ms)。PERF 组当时一行都没覆盖到这个形状:`"a:"×3000` 才 20 ms,而带 `://`
    // 的那行被 scheme 前瞻瞬间否掉。
    label: "冒号密集、无 @(程序名校验)",
    input: ":".repeat(100_000),
    reachesPasses: false,
    note: "R6-审:第一版 DSN 形状正则在这里 19 秒;改成 indexOf/lastIndexOf 后线性",
  },
  {
    label: "多个赋值 + 长值(无空白)",
    input: "x " + Array.from({ length: 200 }, (_, i) => `V${i}='a'`).join(""),
    reachesPasses: true,
    note: "R5-nit:`(^|[SHELL_BREAK])` 前导在同一串上反复命中,测的是匹配次数而不是单次回溯",
  },
];
