/**
 * SidePane「档案」页签内容——决策②修订（2026-10-16 WREN 真机拍板，V4-S3）：
 * 宽屏 MainArea 6/4 分屏整体退役，档案唯一落位 = 本页签（宽屏窄屏同一
 * 形态）。ResearchPanel 组件本体不动（未决问题/研究线/孤儿区/行内纠正
 * 全保留），这里只做挂载：.sp-archive 弹性填充页签体，看板可用满高。
 */

import type React from 'react';

import { ResearchPanel } from './ResearchPanel';

export function SidePaneArchive(): React.JSX.Element {
  return (
    <div className="sp-archive">
      <ResearchPanel />
    </div>
  );
}
