import { annotateQualityErrors } from './calendar-workflow-policy.mjs';
import { isConcretePenpaPuzzleUrl } from './puzzle-url.mjs';

export const RULE_AUDIT_ITEMS=Object.freeze(['name','description','example']);
export const RULE_REQUIRED_APPROVALS=3;
export const RULE_EXAMPLE_URL_MAX_LENGTH=4096;

export function getRuleFieldErrors(rule) {
  const errors=[];
  if (!String(rule.titleZh||'').trim()) errors.push({code:'missingZhName',item:'name',message:'缺少中文名称'});
  if (!String(rule.titleEn||'').trim()) errors.push({code:'missingEnName',item:'name',message:'缺少英文名称'});
  if (!Array.isArray(rule.rulesZh)||!rule.rulesZh.some((clause)=>String(clause).trim())) errors.push({code:'missingZhDescription',item:'description',message:'缺少中文说明'});
  if (rule.isVariant && (!rule.baseRuleId || rule.baseRuleValid === false)) errors.push({code:'missingVariantBase',item:'description',message:'变体缺少有效的基础规则'});
  if (!String(rule.exampleUrl||'').trim()) errors.push({code:'missingExample',item:'example',message:'缺少例题链接'});
  return annotateQualityErrors(errors.map((error)=>({...error,revision:rule.revisions?.[error.item]||1})),rule.errorIgnores||[]);
}

export function isRuleItemComplete(rule,item) {
  const errors=getRuleFieldErrors(rule);
  return !errors.some((error)=>error.item===item&&!error.ignored);
}

export function validateRuleExampleUrl(value) {
  return typeof value==='string' && (value.trim()==='' || (value.length<=RULE_EXAMPLE_URL_MAX_LENGTH && isConcretePenpaPuzzleUrl(value.trim())));
}
