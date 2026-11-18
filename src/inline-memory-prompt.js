export const INLINE_MEMORY_PROMPT = `【千千结 · 随正文生成记忆 v1】
正常完成本轮剧情正文后，在回复末尾另起一行输出且只输出一个 <qqj_memory>…</qqj_memory> 区块。区块不属于剧情，不要在其中继续创作。即使没有变化，也填写本轮摘要和所需空数组。不要把区块放在思考、注释、代码围栏或正文包裹标签内。

区块内是一个合法 JSON 对象：双引号、无注释、无尾随逗号；字符串中的换行和双引号须转义。version 固定为 1。只提取本轮用户输入与刚完成的剧情正文，过去资料仅用于辨认人物、地点和旧事项，不重新记作本轮新事实。只写正文支持的内容，未知不编造，计划、尝试、完成、转述和内心想法须区分。用角色实际姓名，不要使用用户或角色占位符。

若输入中有 <qqj_memory_reference>，它是插件提供的只读历史参考：knownPeople/knownPlaces 的 ref 可分别复制到 sameAsEntityKey/sameAsPlaceKey，qianshiCandidates 的 ref 可用于 links.candidateKey。仅在确认同一身份、地点或持续事项时引用；不得自造引用，也不得把历史参考当作本轮事件。没有参考时省略这些可选引用，仍可用明确姓名记录新事实。sourceFloorKey 统一写 current；source 仅允许 canonicalContent（刚完成的剧情正文）或 precedingUserInput（本轮用户输入）。exactQuote 必须是对应来源中的连续原句，不能引用记忆区块自己。

按以下字段记录；无内容填 []，不得删掉字段：
• summary：客观、紧凑地记录本轮重要经过、结果、关系变化、约定和未完成事项。通常 200—500 字，最多 4000 字；不续写、不评论，不用小标题代替经过。
• people：本轮涉及的人物，字段 name、aliases、role、presence。role 为 user 或 character；presence 为 present（在场）、remote（远程参与）、mentioned（仅提及）或 privateCognitionOnly（只出现其内心）。引用其他字段的人物也列在这里。aliases 只写稳定姓名/称谓。
• time：每项包含 sourceText、description、kind、normalized、precision。kind 为 explicit/relative/sequenceOnly/unknown；precision 为 exact/approximate/unresolved；不能确定标准时间时 normalized 为 null。
• locations：每项 name、change、people；change 为 present/entered/left/movedThrough/mentioned，people 为姓名数组。
• actions：actor、targets（姓名数组）、action、completion、result；completion 为 intended/attempted/completed/interrupted/uncertain，未知 result 为 null。
• knowledge：本轮观察到的事实，字段 subject、kind、description；kind 为 physical/injury/object/environment/situational/other。未知 subject 为 null。
• informationTransfers：from、to（姓名数组）、claimText、channel；channel 为 told/shown/written/overheard/discovered。转述不自动成为客观事实。
• privateThoughts：holder、thought、kind；kind 为 thought/emotion/intention/dream/privateDecision/suspicion，私人想法不等于他人知情。
• commitments：issuer、recipient、content、kind、status；kind 为 promise/agreement/command/codePhrase/plan/boundary，status 为 made/accepted/refused/uncertain。
• exactQuotes：仅需日后逐字核对的原句，每项 exactText、speaker、whyPreserve、source；否则留空。
• openLoops：仍未解决且影响后续的事项，每项 description、owners（姓名数组）。
• cseSignals：确实发生的人物状态变化线索，每项 subject、object、signalType、description；signalType 为 emotion/boundary/conflict/reconciliation/vulnerability/trust/betrayal/repeatedPattern/relationDefinition/persistentCondition/other。无对象时 object 为 null。
• spatialFacts：含 places、containments、positions 三个数组。地点 places 每项 key（place-mention-1 等）、name、identity（new/existing/uncertain）、source、sourceFloorKey、exactQuote；旧地点可加 sameAsPlaceKey。containments 每项 placeKey、parentPlaceKey、source、sourceFloorKey、exactQuote，键引用本次 places。positions 每项 subject、placeKey、status（confirmed/lastSeen/leftUnknown）、source、sourceFloorKey、exactQuote；未知去向 placeKey 为 null。不根据路过、回忆或旧设定猜测篇末位置。
• placePaths：正文明确完整地点归属时记录；每项 path（按大到小的地点对象数组，每个对象至少 name）、placeKey（对应本次 places 的叶地点）、source、sourceFloorKey、exactQuote。没有明确归属依据则留空。
• qianshi：含 events、order。events 每项 key（event-1 等）、sourceFloorKey、title、description、status、actionStatus、storyTime、scheduledTime、people、object、matter、links。status/actionStatus 为 planned/inProgress/completed/cancelled/occurred/unknown；storyTime 是发生时间，scheduledTime 是约定时间，未知为 null。people 为姓名数组，object 为重要物品或 null。持续计划/事项 matter=true，一次性事件 false。同一事项的连续微动作合并，无新增事实不重复登记。links 仅在参考列表确有对应旧事项时写 [{"candidateKey":"逐字复制ref","kind":"progress"}]，只补旧事背景时 kind=context；否则 []，每项最多一个旧事项链接。order 仅记录明确先后，格式 [{"before":"event-1","after":"event-2","certainty":"explicit"}]，不确定则 []。

以下仅展示完整结构；正式输出要根据本轮填写，不得照抄示例或全部机械留空：
<qqj_memory>
{"version":1,"summary":"本轮实际剧情摘要","people":[],"time":[],"locations":[],"actions":[],"knowledge":[],"informationTransfers":[],"privateThoughts":[],"commitments":[],"exactQuotes":[],"openLoops":[],"cseSignals":[],"spatialFacts":{"places":[],"containments":[],"positions":[]},"placePaths":[],"qianshi":{"events":[],"order":[]}}
</qqj_memory>`;
