/**
 * USB HID Report Descriptor parser and domain model for peripheral reverse engineering.
 * Decodes raw HID descriptor bytes into structured collections, usage pages,
 * report IDs, and field layouts.
 */

export interface HidItem {
  readonly tag: number;
  readonly type: "main" | "global" | "local" | "reserved";
  readonly data: number;
  readonly byteLength: number;
}

export interface HidEndpointReport {
  readonly reportId: number | null;
  readonly reportType: "input" | "output" | "feature";
  readonly usagePage: number;
  readonly usagePageHex: string;
  readonly usage: number;
  readonly usageHex: string;
  readonly reportSizeBits: number;
  readonly reportCount: number;
  readonly totalSizeBytes: number;
}

export interface ParsedHidDescriptor {
  readonly items: readonly HidItem[];
  readonly reports: readonly HidEndpointReport[];
  readonly vendorUsagePages: readonly string[];
}

/** Human-readable names for standard USB HID Usage Pages. */
export const HID_USAGE_PAGE_NAMES: Record<number, string> = {
  0x01: "Generic Desktop Controls",
  0x02: "Simulation Controls",
  0x03: "VR Controls",
  0x04: "Sport Controls",
  0x05: "Game Controls",
  0x06: "Generic Device Controls",
  0x07: "Keyboard/Keypad",
  0x08: "LEDs",
  0x09: "Button",
  0x0c: "Consumer",
  0x0d: "Digitizers",
  0x0e: "Haptics",
};

interface HidParserState {
  currentUsagePage: number;
  currentUsage: number;
  currentReportId: number | null;
  currentReportSize: number;
  currentReportCount: number;
  readonly vendorUsagePages: Set<string>;
  readonly reports: HidEndpointReport[];
}

function handleGlobalItem(
  bTag: number,
  data: number,
  state: HidParserState,
): void {
  switch (bTag) {
    case 0x00: // Usage Page
      state.currentUsagePage = data;
      if (data >= 0xff00 && data <= 0xffff) {
        state.vendorUsagePages.add(`0x${data.toString(16).toUpperCase()}`);
      }
      break;
    case 0x07: // Report Size
      state.currentReportSize = data;
      break;
    case 0x08: // Report ID
      state.currentReportId = data;
      break;
    case 0x09: // Report Count
      state.currentReportCount = data;
      break;
  }
}

function handleMainItem(bTag: number, state: HidParserState): void {
  if (bTag !== 0x08 && bTag !== 0x09 && bTag !== 0x0b) return;
  const reportType =
    bTag === 0x08 ? "input" : bTag === 0x09 ? "output" : "feature";
  const totalBits = state.currentReportSize * state.currentReportCount;
  const totalSizeBytes =
    Math.ceil(totalBits / 8) + (state.currentReportId !== null ? 1 : 0);

  state.reports.push({
    reportId: state.currentReportId,
    reportType,
    usagePage: state.currentUsagePage,
    usagePageHex: `0x${state.currentUsagePage.toString(16).toUpperCase()}`,
    usage: state.currentUsage,
    usageHex: `0x${state.currentUsage.toString(16).toUpperCase()}`,
    reportSizeBits: state.currentReportSize,
    reportCount: state.currentReportCount,
    totalSizeBytes,
  });
}

/** Parse raw USB HID Report Descriptor bytes. */
export function parseHidReportDescriptor(
  rawBytes: Uint8Array | readonly number[],
): ParsedHidDescriptor {
  const bytes = Array.from(rawBytes);
  const items: HidItem[] = [];
  const state: HidParserState = {
    currentUsagePage: 0,
    currentUsage: 0,
    currentReportId: null,
    currentReportSize: 0,
    currentReportCount: 0,
    vendorUsagePages: new Set<string>(),
    reports: [],
  };

  let offset = 0;
  while (offset < bytes.length) {
    const prefix = bytes[offset] ?? 0;
    offset++;

    const bSize = prefix & 0x03;
    const bType = (prefix >> 2) & 0x03;
    const bTag = (prefix >> 4) & 0x0f;

    const dataLength = bSize === 3 ? 4 : bSize;
    let data = 0;
    for (let i = 0; i < dataLength && offset < bytes.length; i++) {
      data |= (bytes[offset] ?? 0) << (i * 8);
      offset++;
    }

    const typeName =
      bType === 0
        ? "main"
        : bType === 1
          ? "global"
          : bType === 2
            ? "local"
            : "reserved";

    items.push({ tag: bTag, type: typeName, data, byteLength: 1 + dataLength });

    if (typeName === "global") {
      handleGlobalItem(bTag, data, state);
    } else if (typeName === "local" && bTag === 0x00) {
      state.currentUsage = data;
    } else if (typeName === "main") {
      handleMainItem(bTag, state);
    }
  }

  return {
    items,
    reports: state.reports,
    vendorUsagePages: Array.from(state.vendorUsagePages).sort(),
  };
}
