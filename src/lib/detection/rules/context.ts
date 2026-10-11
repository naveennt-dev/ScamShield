/**
 * Text that talks ABOUT scams — a bank's safety tip, a news report, a police advisory — uses the
 * same words as a scam ("OTP", "digital arrest", "account will be blocked") but asks the reader
 * for nothing. It is recognised by awareness/news vocabulary AND the absence of anything addressed
 * to the reader as an instruction. A scam that sprinkles "beware of fraudsters" into a message
 * still addresses the reader ("your account…", "send…") and is not exempted.
 */
const AWARENESS = new RegExp(
  [
    String.raw`\bwarn(s|ed|ing)?\b`,
    String.raw`\bcaution(s|ed)?\b`,
    String.raw`\badvis(e|es|ory)\b`,
    String.raw`\bbeware\b`,
    String.raw`\balert(s|ed)? (citizens|people|the public|customers|users)\b`,
    String.raw`\bfake (messages?|calls?|sms|notices?|kyc|websites?)\b`,
    String.raw`\b(fraudsters|scammers|scam alert|stay safe|be alert|report (fraud|it) at|cybercrime\.gov\.in|1930)\b`,
    String.raw`\bnever (asks?|ask|requests?|calls?|sends?) (you )?(for|to)?\b`,
    // News reporting
    String.raw`\b(busts?|busted|nabbed|arrested|held for|duped|cheated|conned|swindled|defrauded|lost rs|racket|gang)\b`,
    // Hinglish / Hindi safety tips
    String.raw`\b(dhyan rahe|dhyan dein|savdhan|saavdhan|saavdhaan|sawdhan|alert rahe|nahi maangta|nahi mangta|nahi maangti|kabhi nahi maang)\b`,
    "सावधान|ध्यान रखें|कभी नहीं मांग|नहीं मांगता",
  ].join("|"),
  "i",
);

/**
 * Reader-directed instruction: a request or command aimed at "you". Plain mentions of "you" in a
 * tip ("banks never ask you for…") don't count; imperatives that ask for an action do.
 */
const ADDRESSES_READER = new RegExp(
  [
    String.raw`\b(your|yours|aapka|aapke|aapki|tumhara|tumhare|tera|tere)\b`,
    String.raw`\b(you (have|are|will|must|need|won|can claim)|you'?ve won)\b`,
    // An imperative: at the start of a sentence or after please/kindly/now, or pointing somewhere
    // ("click here", "update now", "call 98…"). "fake KYC update messages" is not an instruction.
    String.raw`(^|[.!?\n:]\s*|\b(please|pls|kindly|now|immediately|just|turant|jaldi)\s+)(click|tap|call|contact|reply|send|share|pay|transfer|download|install|scan|update|verify|login|log in)\b`,
    String.raw`\b(click|tap|call|contact|reply|send|share|pay|transfer|download|install|scan|update|verify)\s+(here|now|this|below|immediately|today|on \+?\d|at \+?\d|\+?\d{5,})`,
    String.raw`\b(bhejo|bhej do|karein|kijiye)\b`,
    "आपका|आपके|आपकी|भेजें|भेजो",
  ].join("|"),
  "i",
);

/** Negated imperatives in tips ("never share", "do not click", "share mat karo") aren't requests. */
const NEGATED_IMPERATIVES = /\b(never|do not|don'?t|mat|kabhi)\s+(\w+\s+){0,2}?(click|tap|call|reply|send|share|pay|transfer|download|install|scan|update|verify)\b|\b(click|share|pay|bhejo|karo|karein)\s+mat\b/gi;

/** "SBI never asks for your OTP…": the reader is mentioned only inside what is NOT asked. */
const NEGATED_ASK_CLAUSE = /\b(never|not|don'?t|doesn'?t|do not|does not|will not|won'?t)\s+(asks?|requests?|calls?|sends?|seeks?)\b[^.!?\n]*/gi;

export function isAwarenessText(t: string): boolean {
  if (!AWARENESS.test(t)) return false;
  return !ADDRESSES_READER.test(t.replace(NEGATED_ASK_CLAUSE, " ").replace(NEGATED_IMPERATIVES, " "));
}

/**
 * Does the message ask the reader to DO something a scam needs — follow a link, call or message a
 * number, pay/send/transfer, share or enter details, install something? Used to keep the ML model
 * (trained on generic SMS spam) from raising alarms on its own about messages that ask for nothing
 * (EMI reminders, update notices): it can still warn when the message contains such a request.
 */
const ACTION_REQUEST = new RegExp(
  [
    String.raw`https?://|www\.|\b[a-z0-9-]+\.(com|in|net|org|info|xyz|top|co|io|me|ly|link|site|online|shop|apk)\b`,
    // A phone number: at least 10 digits (so dates like 05-11-2026 and amounts don't count).
    String.raw`\+?\d(?:[ -]?\d){9,}`,
    String.raw`\b(send\w*|pay|paying|payable|transfer\w*|deposit\w*|invest\w*|donate|return|lend|bhej\w*|call|calling|contact\w*|dm|message me|repl(y|ying|ies)|share|sharing|click\w*|tap|download\w*|install\w*|scan|enter|submit\w*|verify|confirm|log ?in|sign ?in|claim\w*|register\w*|apply|join\w*|buy|purchase|redeem|press|recharge)\b`,
    // Money demanded as a fee/charge, and contact handles ("on WhatsApp", "@handle", "t.me/…").
    String.raw`\b(fee|fees|charges?|deposit|registration|membership|access)\b[^.!?\n]{0,25}?(rs\.?|inr|₹|\$|£|€)\s?\d|(rs\.?|inr|₹|\$|£|€)\s?[\d,]+[^.!?\n]{0,20}?\b(fee|fees|charges?|payable|only)\b`,
    String.raw`\b(on|via|at) (whatsapp|telegram|signal)\b|(^|\s)@[a-z0-9_]{4,}|\bt\.me/`,
    // Premium-SMS bait: "text PLAY to 85222".
    String.raw`\b(text|txt|sms)\s+\w+\s+to\s+\d{4,}`,
    "भेज|कॉल|क्लिक|डाउनलोड|ट्रांसफर",
  ].join("|"),
  "i",
);

export function asksReaderToAct(t: string): boolean {
  return ACTION_REQUEST.test(t.replace(NEGATED_IMPERATIVES, " "));
}
