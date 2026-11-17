import test from 'node:test';
import assert from 'node:assert/strict';
import { phoneVariants } from '../src/phone.js';

test('teléfono colombiano se compara completo con o sin país y formato', () => {
  for (const value of ['+57 300 1234567', '3001234567', '(300) 123-4567', '00573001234567']) {
    assert.deepEqual(phoneVariants(value), ['573001234567', '00573001234567', '3001234567']);
  }
});
test('no mezcla países ni toma fragmentos de teléfonos inválidos', () => {
  for(const value of ['3','+5773087093','+5730012345678']) assert.deepEqual(phoneVariants(value),[]);
  assert.deepEqual(phoneVariants('+1 212 555 0100'), ['12125550100', '0012125550100']);
  for (const value of [null, '', 'abc3001234567', '3001234567 ext 3', '123', '0000', '573001234567000000']) assert.deepEqual(phoneVariants(value), []);
});
