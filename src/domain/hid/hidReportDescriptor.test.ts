import { describe, expect, it } from "vitest";
import {
  parseHidReportDescriptor,
  HID_USAGE_PAGE_NAMES,
} from "./hidReportDescriptor.js";

describe("HID Report Descriptor Parser", () => {
  it("decodes standard keyboard input report descriptor items", () => {
    // Standard keyboard descriptor snippet:
    // 0x05, 0x01: Usage Page (Generic Desktop)
    // 0x09, 0x06: Usage (Keyboard)
    // 0xA1, 0x01: Collection (Application)
    // 0x85, 0x01: Report ID (1)
    // 0x05, 0x07: Usage Page (Key Codes)
    // 0x19, 0xE0: Usage Minimum (224)
    // 0x29, 0xE7: Usage Maximum (231)
    // 0x15, 0x00: Logical Minimum (0)
    // 0x25, 0x01: Logical Maximum (1)
    // 0x75, 0x01: Report Size (1 bit)
    // 0x95, 0x08: Report Count (8)
    // 0x81, 0x02: Input (Data, Variable, Absolute)
    // 0xC0: End Collection
    const descriptor = [
      0x05, 0x01, 0x09, 0x06, 0xa1, 0x01, 0x85, 0x01, 0x05, 0x07, 0x19, 0xe0,
      0x29, 0xe7, 0x15, 0x00, 0x25, 0x01, 0x75, 0x01, 0x95, 0x08, 0x81, 0x02,
      0xc0,
    ];

    const result = parseHidReportDescriptor(descriptor);
    expect(result.items.length).toBeGreaterThan(5);
    expect(result.reports.length).toBe(1);

    const report = result.reports[0];
    if (!report) throw new Error("Expected input report");
    expect(report.reportId).toBe(1);
    expect(report.reportType).toBe("input");
    expect(report.usagePage).toBe(0x07);
    expect(report.reportSizeBits).toBe(1);
    expect(report.reportCount).toBe(8);
    // 8 bits = 1 byte payload + 1 byte report ID = 2 bytes total
    expect(report.totalSizeBytes).toBe(2);
  });

  it("identifies custom hardware vendor usage pages (e.g. 0xFF13 for Aula keyboard configuration)", () => {
    // Custom vendor feature report snippet:
    // 0x06, 0x13, 0xFF: Usage Page (Vendor Defined 0xFF13)
    // 0x09, 0x01: Usage (1)
    // 0xA1, 0x01: Collection (Application)
    // 0x15, 0x00: Logical Minimum (0)
    // 0x26, 0xFF, 0x00: Logical Maximum (255)
    // 0x75, 0x08: Report Size (8 bits)
    // 0x95, 0x40: Report Count (64 bytes)
    // 0xB1, 0x02: Feature (Data, Variable, Absolute)
    // 0xC0: End Collection
    const vendorDescriptor = [
      0x06, 0x13, 0xff, 0x09, 0x01, 0xa1, 0x01, 0x15, 0x00, 0x26, 0xff, 0x00,
      0x75, 0x08, 0x95, 0x40, 0xb1, 0x02, 0xc0,
    ];

    const result = parseHidReportDescriptor(vendorDescriptor);
    expect(result.vendorUsagePages).toContain("0xFF13");
    expect(result.reports.length).toBe(1);

    const feature = result.reports[0];
    if (!feature) throw new Error("Expected feature report");
    expect(feature.reportType).toBe("feature");
    expect(feature.usagePage).toBe(0xff13);
    expect(feature.reportSizeBits).toBe(8);
    expect(feature.reportCount).toBe(64);
    expect(feature.totalSizeBytes).toBe(64);
  });

  it("maps well-known usage page names", () => {
    expect(HID_USAGE_PAGE_NAMES[0x01]).toBe("Generic Desktop Controls");
    expect(HID_USAGE_PAGE_NAMES[0x07]).toBe("Keyboard/Keypad");
    expect(HID_USAGE_PAGE_NAMES[0x0c]).toBe("Consumer");
  });
});
