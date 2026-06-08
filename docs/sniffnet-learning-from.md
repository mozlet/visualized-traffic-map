# 向 Sniffnet 学习 —— 设计思路借鉴（思路级，非抄代码）

> **源项目**：[GyulyVGC/sniffnet](https://github.com/GyulyVGC/sniffnet) —— 跨平台网络流量监控（Rust + iced 原生 GUI + pcap 实时抓包）
> **许可证**：MIT / Apache-2.0 双授权（permissive，带署名可安全借鉴，对 ovtm 公开仓库无 GPL 传染风险）
> **本文定位**：代码能抄、思路抄不来只能悟。这里沉淀的是**作者的设计思路**和它们对 ovtm 的开拓价值，不是 copy-paste 清单。
> **架构差异（决定了哪些不能照搬）**：sniffnet = iced 原生 GUI + pcap 抓包；ovtm = Rust 后端 + deck.gl 网页 + NetFlow/flowd 采集。所以 `src/gui`、`src/chart`(plotters-iced)、pcap 整块**渲染/采集代码不可移植**，可移植的是**数据模型、富化流水线、声明式数据**这些与渲染解耦的思路。

---

## 0. 作者的元思路（一句话）

> **把"慢速富化"和"高速计数"解耦，再把同一份流量沿多个正交轴折叠成声明式数据结构——逻辑代码极薄，正确性靠类型系统兜底。**

这与 ovtm 的硬偏好（数据驱动 > if-else 启发式、真实数据 > 推断模型、越用越精确）**完全同源**。下面六条思路都是这条元思路的展开。

---

## 1. 「同一份流量，三个并列聚合视图」

**作者怎么做**（`src/networking/types/info_traffic.rs:16`）：`InfoTraffic` 是心脏，每个包同时打进**三张 HashMap**：

```rust
map:      HashMap<AddressPortPair, InfoAddressPortPair>  // 连接级（五元组）
services: HashMap<Service, DataInfo>                      // 服务级（端口→应用）
hosts:    HashMap<Host, DataInfoHost>                     // 主机级（域名+ASN+国家）
```

**思路精髓**：不预设"用户想看什么维度"，而是把流量沿**三个正交轴**同时折叠——连接 / 服务 / 对端主机，回答三个不同问题（谁在连 · 在用什么协议 · 对方是谁）。`Host`（`host.rs:10`）= `domain + asn + country` 三元组，是"对端身份"的完整定义。

**对 ovtm 的开拓**：ovtm 现在的 livestats（top_dst / top_countries / `/api/apps`）是三条**独立 SQL** 各查各的。sniffnet 启发——这三者本应是**同一个内存滚动聚合的三个投影**。ovtm 可在 ingestor 侧维护窗口聚合（connection / service / host 三轴），前端一次取全；而 `host = 域名+ASN+国家` 这个身份定义比 ovtm 现在按 `dst_ip / country` 更立体（同一 CDN 的多 IP 会归并到同一 ASN 身份）。

**借鉴级别**：🔵 思路级（聚合模型重构，见 §第 4 项落地）

---

## 2. 「方向是数据的固有属性，bits 只在展示时换算」

**作者怎么做**（`src/networking/types/data_info.rs:12`）：每个计数单元存 5 个字段——`incoming_packets / outgoing_packets / incoming_bytes / outgoing_bytes / final_instant`。展示时按 `DataRepr`(Packets/Bytes/Bits) 投影，`Bits = Bytes × 8` 只在 `incoming_data()` 读取时换算（`data_info.rs:26`），不重复存。**字段私有**，只能经 `add_packet()/refresh()` 改——强制 `final_instant` 永远跟计数同步刷新。

**思路精髓**：① 进/出方向是**固有维度**不是查询时才算；② 派生量（bits）不落地存储；③ 把"时间戳必须同步"这条数据完整性约束**写进类型系统**（私有字段 + 方法），而非靠注释和自觉。

**对 ovtm 的开拓**：ovtm 的 flow 有 src/dst 但带宽统计**没有显式的进/出双向模型**。对**家庭网关**场景，"上行 vs 下行"是用户最关心的维度之一（谁在偷偷上传？哪台设备在大量下载？）——而 OPNsense NetFlow 本身就带方向字段。这是 ovtm 可补的一个真实维度。

**借鉴级别**：🔵 思路级（数据模型扩展）

---

## 3. ⭐ 「rDNS 异步富化流水线 + 去重 + 数据回填」——最值得偷的思路

**作者怎么做**（`src/networking/parse_packets.rs:362 / :420 / :446`）：包处理主循环**绝不阻塞做 DNS/GeoIP**：

1. 主循环遇到新 IP → 丢进 `lookup_request_tx` channel，IP 进 `addresses_waiting_resolution`（同一 IP **只发一次**请求——去重）
2. 独立线程 `reverse_dns_lookups` 阻塞做 `lookup_addr` + GeoIP + ASN + bogon 判定，组装成 `Host` 回传
3. 回填（`new_hosts_to_send:446`）：把**解析延迟期间该 IP 累积的流量**（`addresses_waiting_resolution.remove`）合并进刚解析好的 host —— **延迟期的数据一个不丢**

配套的 tick 模型（`info_traffic.rs:108` `take_but_leave_something` + `:32` `refresh`）：后端每 tick 产出**增量** `InfoTraffic`，前端累加器用 `refresh()` 合并，主结构 take 走后只留时间戳/丢包数。

**思路精髓**：慢富化（DNS/Geo）与高速包处理**彻底解耦**；用"待解析队列暂存计数 + 解析完回填"解决"异步期间数据归属"这个经典难题；去重 map 避免对同一 IP 重复打 DNS。

**对 ovtm 的开拓**：这正是 ovtm `geo-doctor` + `mtr-worker` 自我纠错的**同构问题**！ovtm 已是"先 provisional、慢富化后回填"（`corr_lat` 闭环，api 每 120s 从 `ip_geo WHERE corr_lat IS NOT NULL` 载入修正图）。sniffnet 的 `addresses_waiting_resolution` 暂存模式可借进 ingestor：**新 IP 先 provisional geo 入库 + 排队 mtr/rdns，解析回来后把窗口内累积流量按新坐标 relocate** —— 比现在每 120s 全表扫更**增量、更实时**，且天然解决"富化延迟期的流量算谁的"。

**借鉴级别**：🔵 思路级（最高思想价值；映射到 geo-doctor 增量化）

---

## 4. 「枚举即数据，phf 编译期完美哈希」

**作者怎么做**（`build.rs` `build_services_phf` + `src/networking/types/service.rs:6` + `service_query.rs`）：`services.txt`（nmap-services 派生，**12093 条** `service_name\tport/proto`）在 **build.rs 编译期**用 `phf_codegen::Map` 生成 `static SERVICES: phf::Map<ServiceQuery, Service>`，写进 `OUT_DIR/services.rs`。运行时 `(port, protocol)` 查服务名是 **O(1)、零堆分配、零 IO、零锁**。`Service::Name(&'static str)` 用 `Box::leak` 把服务名漏成 `'static`；`Service` 是三态枚举 `Name / Unknown / NotApplicable`。

**思路精髓**：静态参考数据（端口→服务）**编译进二进制**——`services.txt` 是数据源、`build.rs` 是生成器、逻辑代码极薄。这是"数据驱动 > if-else"的彻底贯彻。

**对 ovtm 的开拓**：ovtm 的 SNI 分类（`sni-sniff`）只覆盖 **443 端口**。这张 nmap 端口表覆盖 **DNS/SSH/NTP/SMTP/IMAP…全端口**——补上 SNI 看不到的那一大半流量。正确姿势是 ingestor 侧 `build.rs` + phf 编译进二进制（**不要运行时读文件**），NetFlow 本身给 port+proto，直接可用。给 flow 打 `service` 标签，和 SNI 的 `app` 标签互补（SNI 优先、端口兜底）。

**借鉴级别**：🟢 数据 + 思路（`services.txt` 数据可直接搬，phf+build.rs 模式照学）

---

## 5. 「不可知也是一等状态」

**作者怎么做**：GeoIP 查不到 → 返回 `Country::ZZ`（显式 unknown，`mmdb/country.rs:9`），不 panic、不默认美国。`bogon.rs` 把所有保留网段（this-network / 私网 / CGN / loopback / link-local / 文档地址）做成**带 `description` 字段的结构化列表**。`DataInfoHost`（`data_info_host.rs`）上 `is_local / is_bogon / is_loopback / traffic_type` 都是显式 flag。

**思路精髓**：**"无法归属"是需要被建模的真实状态**，不是错误、不是兜底默认值。这跟 ovtm CLAUDE.md「MaxMind geo 不可靠，假设 geo=null」「anycast 返回 None」的硬偏好**完全同源**。

**对 ovtm 的开拓**：ovtm `geoip/src/lib.rs:108` **已有** `is_private/is_loopback/CGNAT/link-local` 判定，私网→home 坐标。可借鉴的是 **bogon 那张带 `description` 的分类网段表**——让 `geo-doctor` 的 `geo_decisions` 审计能区分「私网→home」vs「文档地址/CGN 等异常段」，审计 reason 更精确。检测逻辑 ovtm 已有，借的是**分类粒度**。

**借鉴级别**：🟡 数据（结构化网段表 → geoip crate，增强审计）

---

## 6. 学不来、只能悟的工程审美

这部分没有可搬的"东西"，是作者贯穿全项目的品味：

- **类型驱动正确性**：`DataInfo` 私有字段强制时间戳同步、`Service` 三态枚举、`Country::ZZ`——把约束写进类型，编译期就挡住错误，而不是靠注释 + code review + 自觉。
- **解耦换吞吐**：慢富化（DNS/Geo/ASN）甩到旁路线程，主循环只管快速计数。瓶颈隔离。
- **数据与代码分离**：端口表(nmap)、国家、bogon、主题配色全是**声明式数据 + 编译期生成**，逻辑代码薄到几乎只有"查表 + 投影"。
- **增量 tick + 合并**：后端产增量、前端 `refresh` 累加，而非每次全量重算。

> **悟到的东西**：ovtm 已经在做对的事（数据驱动路由、geo 自我纠错闭环、真实海缆/陆地图）。sniffnet 的价值不是"教 ovtm 新功能"，而是**印证并强化同一套工程哲学**，并在三处给出更锋利的实现范式：①富化流水线增量化 ②端口表补 SNI 盲区 ③多轴聚合统一投影。

---

## 落地优先级（四项借鉴，思路级框定 + 实现路径）

| # | 借鉴项 | 级别 | 实现路径 | 风险 |
|---|---|---|---|---|
| 1 | **`services.txt` 端口→服务富化** | 🟢 数据+思路 | ingestor 加 `build.rs` + `phf_codegen` 编译 nmap 端口表；flow 打 `service` 标签（SNI 优先、端口兜底）；新增 `/api` 字段或 livestats 面板 | 低（不碰路由/前端几何） |
| 2 | **bogon 分类网段表** | 🟡 数据 | 搬 `bogon.rs` 的带 description 网段表进 `geoip` crate；`geo-doctor` 审计 reason 细化 | 低 |
| 3 | **241 国旗 SVG** | 🟢 资源 | `resources/embedded_icons/countries/*.svg` → ovtm `web/public/`；top_countries 面板渲染国旗 | 低（纯前端，遵 COLOR-STANDARD.md） |
| 4 | **三轴聚合 + 进/出双向模型** | 🔵 思路 | ingestor 滚动窗口三轴聚合（conn/service/host）+ DataInfo 式双向计数；需先写设计、跑基线 | 中（改聚合模型，单独规划） |

> ⚠️ **铁律**：以上任何一项**都不得触碰** `web/src/cables.ts / hubs.ts / landmass.ts / routes.ts` 的路由几何逻辑（见 CLAUDE.md 路由设计准则——5 轮反馈 + 重启警告）。端口富化/国旗/聚合都在采集与展示层，与飞线路由正交。

---

## 署名与许可证合规

借鉴/搬运 sniffnet 的代码或数据时，在相应文件头保留：

```
// Adapted from sniffnet (https://github.com/GyulyVGC/sniffnet)
// Copyright (c) 2022 Bellini Giuliano — Licensed under MIT OR Apache-2.0
```

`services.txt` 本身派生自 [nmap-services](https://raw.githubusercontent.com/nmap/nmap/master/nmap-services)（nmap 许可证），若直接采用应注明 nmap 上游来源。国旗 SVG 资源同理保留 sniffnet 出处。

---

*生成于 2026-06-08 · ovtm（opn-visualized-traffic-map）· 深读 sniffnet 核心模块：`info_traffic` / `data_info` / `parse_packets`(rDNS pipeline) / `service`+`build.rs`(phf) / `mmdb` / `bogon` / `notifications`*
