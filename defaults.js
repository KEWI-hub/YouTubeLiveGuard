// Shared default settings (used by the isolated content script and the popup).
const YTLG_DEFAULTS = {
  enabled: true,
  autoJumpOnStall: true,   // กระตุก/บัฟเฟอร์ค้าง -> กด LIVE
  stallSeconds: 2,         // ค้างกี่วินาทีถึงนับว่ากระตุก
  frequentStalls: 3,       // กระตุกสั้นๆ กี่ครั้งใน 1 นาทีแล้วเด้ง LIVE
  autoJumpOnLatency: true, // หลุดจาก Live Now เกินกำหนด -> กด LIVE
  maxLatency: 30,          // วินาทีที่ยอมให้ช้ากว่า Live
  autoLowerQuality: false, // เด้ง LIVE แล้วยังกระตุกซ้ำ -> ลดความละเอียด 1 ขั้น
  showOverlay: true,
  cooldown: 8              // วินาทีขั้นต่ำระหว่างการเด้ง LIVE อัตโนมัติ
};
