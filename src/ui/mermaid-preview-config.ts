import type { MermaidConfig } from 'mermaid';

/** Local presentation only: the caller passes the author's Mermaid source
 * unchanged. Pin appearance instead of inheriting version-dependent defaults
 * (Mermaid 12 adds shadows and a 120px minimum label width). */
export function mermaidPreviewConfig(maxTextSize: number): MermaidConfig {
  return {
    startOnLoad: false,
    securityLevel: 'strict',
    htmlLabels: false,
    maxTextSize,
    maxEdges: 1000,
    suppressErrorRendering: true,
    theme: 'base',
    look: 'classic',
    layout: 'dagre',
    fontFamily: '-apple-system, BlinkMacSystemFont, "PingFang SC", "Microsoft YaHei", sans-serif',
    themeVariables: {
      background: '#ffffff',
      primaryColor: '#ffffff',
      primaryBorderColor: '#646a73',
      primaryTextColor: '#1f2329',
      secondaryColor: '#f5f6f7',
      tertiaryColor: '#f5f6f7',
      lineColor: '#646a73',
      edgeLabelBackground: '#ffffff',
      fontSize: '14px',
      nodeShadow: false,
    },
    flowchart: {
      htmlLabels: false,
      minNodeWidth: 0,
      padding: 12,
      nodeSpacing: 40,
      rankSpacing: 60,
      diagramPadding: 16,
      curve: 'basis',
    },
  };
}
