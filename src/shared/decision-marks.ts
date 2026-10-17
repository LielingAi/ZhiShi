/**
 * 跨 wire 哨兵字符串的单一事实源（2.0 audit D4：server 常量 + GUI 两处
 * 字面量硬编码收敛为 shared 常量）。
 *
 * NO_BASELINE_MARK：决策提请里"专家库无基准"的哨兵行——服务端在
 * expertHits 为空时注入该字符串，GUI 决策面板按值原样呈现。字符串同时
 * 跨 wire 又出现在展示层，改这个值必须两端同源。
 */

/** 专家库边界标注：库中无基准（决策提请 expertHits 的空态哨兵）。 */
export const NO_BASELINE_MARK = '库中无基准';
