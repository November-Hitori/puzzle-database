import test from 'node:test';
import assert from 'node:assert/strict';
import { getRuleFieldErrors, isRuleItemComplete, RULE_AUDIT_ITEMS, RULE_EXAMPLE_URL_MAX_LENGTH, RULE_REQUIRED_APPROVALS, validateRuleExampleUrl } from '../rule-policy.mjs';

test('rule quality derives bilingual deficits and variant base requirements',()=>{
  const draft={titleZh:'中文名',titleEn:'',rulesZh:['中文说明'],rulesEn:[],isVariant:true,baseRuleId:null,exampleUrl:''};
  assert.deepEqual(getRuleFieldErrors(draft).map((error)=>error.code),['missingEnName','missingEnDescription','missingVariantBase','missingExample']);
  assert.equal(isRuleItemComplete(draft,'name'),false);
  assert.equal(isRuleItemComplete(draft,'description'),false);
  assert.equal(isRuleItemComplete(draft,'example'),false);
  assert.equal(RULE_REQUIRED_APPROVALS,3);
  assert.deepEqual(RULE_AUDIT_ITEMS,['name','description','example']);
});

test('example URL policy allows a blank draft but only concrete Penpa links',()=>{
  assert.equal(validateRuleExampleUrl(''),true);
  assert.equal(validateRuleExampleUrl('   '),true);
  assert.equal(validateRuleExampleUrl('https://penpa-edit.com/?m=edit&p=sample'),true);
  assert.equal(validateRuleExampleUrl('https://puzz.link/p?slither/6/6/abc'),false);
  assert.equal(validateRuleExampleUrl('javascript:alert(1)'),false);
  assert.equal(validateRuleExampleUrl('https://penpa-edit.com:444/?m=edit&p=sample'),false);
  const prefix='https://penpa-edit.com/?m=edit&p=';
  const atLimit=prefix+'x'.repeat(RULE_EXAMPLE_URL_MAX_LENGTH-prefix.length);
  assert.equal(atLimit.length,RULE_EXAMPLE_URL_MAX_LENGTH);
  assert.equal(validateRuleExampleUrl(atLimit),true);
  assert.equal(validateRuleExampleUrl(`${atLimit}x`),false);
  assert.equal(validateRuleExampleUrl('https://swaroopg92.github.io/penpa-edit/#m=edit&p='+'x'.repeat(3300)),true);
});
