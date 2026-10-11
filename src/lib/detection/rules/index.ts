import { OTP_RULES } from "./otp";
import { PAYMENT_RULES } from "./payment";
import { KYC_RULES } from "./kyc";
import { BANKING_RULES } from "./banking";
import { LOTTERY_RULES } from "./lottery";
import { JOB_RULES } from "./job";
import { INVESTMENT_RULES } from "./investment";
import { IMPERSONATION_RULES } from "./impersonation";
import { DELIVERY_RULES } from "./delivery";
import { MALWARE_RULES } from "./malware";
import { LOAN_RULES } from "./loan";
import { ROMANCE_RULES } from "./romance";
import { URGENCY_RULES } from "./urgency";
import { ADVERSARIAL_RULES } from "./adversarial";
import { LINKS_RULES } from "./links";
import { UTILITY_RULES } from "./utility";
import { PERSONAL_RULES } from "./personal";
import { ACCOUNT_RULES } from "./account";
import type { RuleDefinition } from "../types";

export { COMBOS, CRITICAL_RULES } from "./combos";

/** All rules, grouped by scam family (one module per family). */
export const RULES: RuleDefinition[] = [
  ...OTP_RULES,
  ...PAYMENT_RULES,
  ...KYC_RULES,
  ...BANKING_RULES,
  ...LOTTERY_RULES,
  ...JOB_RULES,
  ...INVESTMENT_RULES,
  ...IMPERSONATION_RULES,
  ...DELIVERY_RULES,
  ...MALWARE_RULES,
  ...LOAN_RULES,
  ...ROMANCE_RULES,
  ...URGENCY_RULES,
  ...ADVERSARIAL_RULES,
  ...LINKS_RULES,
  ...UTILITY_RULES,
  ...PERSONAL_RULES,
  ...ACCOUNT_RULES,
];
