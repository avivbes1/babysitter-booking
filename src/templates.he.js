'use strict';

// Gender helpers
const g = (gender, f, m) => gender === 'm' ? m : f;

const TEMPLATES = {
  intro: (v, gender) =>
    `שלום ${v.name}, כאן שירות תיאום השמרטפות של משפחת ${v.family}.\n` +
    `דרך המספר הזה ${g(gender, 'תקבלי', 'תקבל')} מדי פעם הצעות לשמרטפות.\n` +
    `לכל שאלה אפשר לפנות ל-${v.admin}.\nתודה! 🙂`,

  offer: (v, gender) => {
    const rate_line = v.rate ? `התעריף: ${v.rate} ₪ לשעה.\n` : '';
    return `שלום ${v.name}, יש לנו בקשה לשמרטפות ל${v.day}, ${v.date}, משעה ${v.start} עד ${v.end}.\n` +
      rate_line +
      `${g(gender, 'את', 'אתה')} ${g(gender, 'פנויה', 'פנוי')}? אפשר להשיב כן או לא.`;
  },

  refer: (v, gender) =>
    `תודה על השאלה! לגבי הפרטים, ${v.admin} מהמשפחה ${g(gender, 'תיצור', 'ייצור')} איתך קשר בהקדם.`,

  ack: (v) =>
    `מעולה, תודה ${v.name}! ${v.admin} מהמשפחה יצור איתך קשר לסגירת הפרטים.`,

  already_booked: (v) =>
    `תודה רבה ${v.name}! בינתיים כבר נסגרה שמרטפית אחרת לתאריך הזה.\nנשמח לפנות אלייך בפעם הבאה 🙏`,

  decline_ack: (v) =>
    `תודה ${v.name}, מובן לגמרי. נשמח לפנות אלייך בפעם הבאה 🙏`,

  reminder: (v) =>
    `שלום ${v.name}! תזכורת: שמרטפות אצל משפחת ${v.family} היום, ${v.date}, משעה ${v.start} עד ${v.end}.\nמחכים לך! 😊`,

  cancellation: (v) =>
    `שלום ${v.name}, מצטערים להודיע שהשמרטפות לתאריך ${v.date} (${v.start}–${v.end}) בוטלה.\nתודה על ההיענות 🙏`,

  opt_out: () =>
    `קיבלנו! לא נשלח לך יותר הודעות 🙏`,
};

const MASTER = {
  decline: (v) =>
    `📋 עדכון שמרטפות [${v.date} ${v.start}–${v.end}]: קיבלנו סירוב מ-${v.sitter_name}.\n` +
    `מתוך ${v.total} הצעות: ${v.accepted} אישור/ים, ${v.declined} סירוב/ים, ${v.pending} ממתינות.`,

  fill: (v) =>
    `✅ נסגרה שמרטפית: ${v.name} — ${v.day}, ${v.date}, ${v.start}–${v.end} ` +
    `(${v.hours} שעות, ${v.rate} ₪/שעה, סה״כ משוער ${v.total} ₪).`,

  expiry: (v) =>
    `⚠️ לא נמצאה שמרטפית לתאריך ${v.date} ${v.start}–${v.end}. יש לתאם ידנית.`,

  cancel: (v) =>
    `❌ הזמנת שמרטפות ל-${v.date} ${v.start}–${v.end} בוטלה.`,

  no_sitters: () =>
    `⚠️ אין שמרטפיות פעילות במערכת. יש להוסיף שמרטפיות לפני הזמנה.`,
};

function render(type, vars, gender = 'f') {
  const fn = TEMPLATES[type];
  if (!fn) throw new Error(`Unknown template type: ${type}`);
  return fn(vars, gender);
}

function renderMaster(type, vars) {
  const fn = MASTER[type];
  if (!fn) throw new Error(`Unknown master template type: ${type}`);
  return fn(vars);
}

module.exports = { render, renderMaster };
