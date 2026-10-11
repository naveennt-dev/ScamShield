import { HI_GAP, re, rule } from "./shared";
import { findAll, findAny, findNonNegated } from "./matchers";
import type { RuleDefinition } from "../types";

/**
 * Scams that impersonate PEOPLE rather than organisations: a relative on a "new number", a friend
 * stranded abroad, a boss who needs gift cards, and extortion ("I have your video").
 */

/** An amount: "4000", "15,000", "2,00,000". Linear-time (no nested [\d,] repetition — ReDoS). */
const AMOUNT = String.raw`\b\d{1,3}(?:,\d{2,3})+\b|\b\d{3,}\b`;

const MONEY_ASK =
  String.raw`\b(send|transfer|pay|lend|wire|gpay|g pay|phonepe|paytm|bhej(o|do|dena|iye|dijiye)?|daal do|kar do)\b[^.!?\n]{0,50}?(\b(rs\.?|inr|₹|\$|£|€)\s?\d|${AMOUNT}|\bmoney\b|\bpaise\b|\bpaisa\b|\bupi\b|\bamount\b|\bbill\b|\bfees?\b)` +
  // Hinglish is verb-final: "10000 bhej do", "paise transfer kar do", "number pe gpay karo".
  String.raw`|(\b(rs\.?|inr|₹)\s?\d|${AMOUNT}|\bpaise\b|\bpaisa\b|\bnumber pe\b|\bupi pe\b)[^.!?\n]{0,20}?\b(bhej(o|do|dena|iye|dijiye)?|transfer kar(o|do|dena)?|(gpay|paytm|phonepe|upi) kar(o|do|dena)?|daal do|de do)\b`;

export const PERSONAL_RULES: RuleDefinition[] = [
  rule(
    {
      id: "person.new_number_money",
      category: "other",
      severity: "high",
      weight: 0.55,
      description: "Someone claiming to be family or a friend on a NEW or borrowed number asks for money — call them on the number you already have before paying.",
    },
    (t) =>
      findAll(t, [
        re(String.raw`\b(new number|naya number|dusra number|doosra number|second number|other number|alternate number|my number changed|number badal|changed my number|(my |mera )?(phone|mobile)\b[^.!?\n]{0,30}?\b(broke|broken|lost|stolen|fell|dropped|damaged|kharab|toot|gir gaya|kho gaya|chori)|phone (is )?(someone else'?s|kisi aur ka)|(this is|ye) (a )?(friend'?s|dost ka|kisi aur ka) (phone|number))\b`),
        re(MONEY_ASK),
      ]) ??
      findAll(t, [re(`(?:नया नंबर|फ़ोन खराब|फोन खराब|किसी और का फोन)`), re(`(?:पैसे|रुपये|₹)${HI_GAP(40)}(?:भेज|ट्रांसफर)`)]),
  ),
  rule(
    {
      id: "person.secret_money_request",
      category: "other",
      severity: "medium",
      weight: 0.3,
      description: "Asks for money while telling you not to call or not to tell anyone — a way to stop you checking with the real person.",
    },
    (t) =>
      findAll(t, [
        re(MONEY_ASK),
        re(String.raw`\b(don'?t|do not|pls don'?t|please don'?t|can'?t|cannot) (call|phone|ring|tell|inform|discuss)|\b(mat batana|kisi ko mat|call mat|phone mat)\b|\bkeep (this|it) (confidential|secret|between us)\b`),
      ]),
  ),
  rule(
    {
      id: "pay.gift_card_request",
      category: "other",
      severity: "high",
      weight: 0.6,
      description: "Asks you to buy gift cards and send the codes — no genuine boss, company or government asks for payment in gift cards.",
    },
    (t) =>
      findAll(t, [
        re(String.raw`\b(buy|purchase|get|pick up|arrange|need|want|require)\b[^.!?\n]{0,40}?\b(gift ?cards?|google play cards?|play store cards?|itunes cards?|apple cards?|steam cards?|amazon (pay )?(gift )?vouchers?|vouchers?)\b`),
        re(String.raw`\b(send|share|text|email|forward|scratch)\b[^.!?\n]{0,30}?\b(codes?|card numbers?|pins?|pictures? of|photos? of)\b|\b(confidential|surprise|client|urgent|asap|today|right now)\b`),
      ]),
  ),
  rule(
    {
      id: "extortion.intimate_content",
      category: "other",
      severity: "high",
      weight: 0.7,
      description: "Threatens to leak private videos or photos unless you pay — sextortion. Don't pay; report it at cybercrime.gov.in (1930).",
    },
    (t) =>
      findAll(t, [
        re(String.raw`\b(video|videos|photos?|pics?|pictures?|recording|recorded|footage|webcam|camera|screenshots?|chats?)\b`),
        // A threat to distribute it: to contacts/family/the internet, or "make it viral / leak it".
        re(String.raw`\b(contacts?|contact list|family|friends|relatives|colleagues|social media|internet|everyone|youtube|instagram|facebook|sab(ko)?|ghar( walon| wale| walo)?)\b[^.!?\n]{0,40}?\b(receives?|will (get|see|receive)|bhej\w*|daal\w*|dikha\w*)\b|\b(send|leak|share|post|upload|forward|expose|publish|daal dunga|bhej dunga|bhejunga)\b[^.!?\n]{0,50}?\b(contacts?|family|friends|relatives|colleagues|social media|internet|everyone|youtube|sab(ko)?|ghar)\b|\b(viral|leak)\b`),
        re(String.raw`\b(pay|transfer|bitcoin|btc|crypto|bhejo|bhej do|de do|warna|otherwise|or else|within \d+ ?(hours?|hrs?|days?))\b`),
      ]),
  ),
  rule(
    {
      id: "pay.wrong_transfer_return",
      category: "upi",
      severity: "high",
      weight: 0.5,
      description: "Says money was sent to you “by mistake” and asks you to return it — check your bank app first; it's usually a fake credit message.",
    },
    (t) =>
      findAll(t, [
        re(String.raw`\b(by mistake|mistakenly|accidentally|wrongly (sent|transferred)|sent (it )?(to you )?by mistake|galti se|bhool se|wrong (number|account|upi))\b`),
        re(String.raw`\b(return|send (it |the money )?back|refund|reverse|wapas|lauta)\b`),
      ]),
  ),
  rule(
    {
      id: "charity.direct_upi_donation",
      category: "other",
      severity: "medium",
      weight: 0.35,
      description: "A forwarded appeal asking for donations straight to a personal UPI ID or number — donate only through a verified charity or hospital.",
    },
    (t) =>
      findAll(t, [
        re(String.raw`\b(donate|donation|contribute|help (him|her|them|the family)|madad|daan)\b`),
        re(String.raw`[\w.-]+@(ybl|okaxis|oksbi|okhdfcbank|okicici|paytm|ibl|axl|upi|apl)\b|\b(gpay|phonepe|paytm|upi)\b[^.!?\n]{0,25}?\b\d{10}\b`),
      ]),
  ),
  rule(
    {
      id: "shop.advance_payment_only",
      category: "other",
      severity: "medium",
      weight: 0.3,
      description: "A seller who accepts only advance payment (no cash on delivery, no platform checkout) — a common fake-shop pattern.",
    },
    (t) =>
      findAny(t, [
        re(String.raw`\b(no cod|cod not available|cash on delivery (is )?not available|only (prepaid|advance)|(pay|payment) (in )?advance (only|on upi|via upi|first)|advance payment (only|required|first))\b`),
        re(String.raw`\b(advance|pehle)\b[^.!?\n]{0,25}?\b(payment|pay|bhejo|karo)\b[^.!?\n]{0,40}?\b(upi|gpay|phonepe|paytm)\b`),
      ]),
  ),
  rule(
    {
      id: "cred.wallet_seed_phrase",
      category: "investment",
      severity: "high",
      weight: 0.75,
      description: "Asks for your crypto wallet recovery (seed) phrase or private key — anyone who has it can empty your wallet.",
    },
    (t) =>
      findNonNegated(t, [
        re(String.raw`\b(?<verb>enter|share|send|type|submit|provide|verify|validate|import|confirm)\b[^.!?\n]{0,50}?\b(seed phrase|recovery phrase|secret phrase|mnemonic|private key|12[- ]word|24[- ]word)\b`),
        re(String.raw`\b(seed phrase|recovery phrase|secret phrase|private key)\b[^.!?\n]{0,40}?\b(?<verb>enter|share|send|submit|provide|verify|validate)\b`),
        re(String.raw`\b(?<verb>connect) (your )?wallet\b[^.!?\n]{0,60}?\b(claim|airdrop|free|reward|verify|validate|unlock)\b`),
      ]),
  ),
];
