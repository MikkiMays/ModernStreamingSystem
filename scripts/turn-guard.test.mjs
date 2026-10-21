import { test } from 'node:test';
import assert from 'node:assert/strict';
import { complement, ipv4, peerRules, permits, restricted } from './turn-guard.mjs';

const NODE = '203.0.113.7';
// Куда relay не должен вести ни при каких условиях: публичный интернет, сам сервер изнутри, облачные
// метаданные, CGNAT, сеть Docker и частные сети.
const FORBIDDEN = [
  '8.8.8.8',
  '1.1.1.1',
  '203.0.113.8',
  '203.0.113.6',
  '127.0.0.1',
  '10.0.0.1',
  '172.17.0.1',
  '192.168.1.1',
  '169.254.169.254',
  '100.64.0.1',
  '0.0.0.0',
  '255.255.255.255',
];

test('без правил LiveKit пускает relay к любому публичному адресу — это и есть дыра A12', () => {
  assert.equal(permits({}, '8.8.8.8'), true);
  assert.equal(permits({}, '10.0.0.1'), false);
});

test('с правилами relay ведёт только к SFU этой машины', () => {
  const rules = peerRules(NODE);
  assert.equal(permits(rules, NODE), true);
  for (const peer of FORBIDDEN) assert.equal(permits(rules, peer), false, peer);
  assert.equal(permits(rules, '2001:db8::1'), false);
  assert.equal(rules.allow_restricted_peer_cidrs, undefined);
});

test('дополнение адреса — 32 непересекающиеся сети, вместе всё IPv4, кроме него самого', () => {
  for (const address of [NODE, '192.0.2.1', '0.0.0.1', '255.255.255.254', '128.0.0.0']) {
    const nets = complement(address);
    assert.equal(nets.length, 32);
    let covered = 0;
    for (const net of nets) {
      const [start, length] = net.split('/');
      const size = 2 ** (32 - Number(length));
      assert.equal(ipv4(start) % size, 0, net);
      covered += size;
      const n = ipv4(address);
      assert.ok(n < ipv4(start) || n >= ipv4(start) + size, `${net} содержит ${address}`);
    }
    assert.equal(covered, 2 ** 32 - 1);
  }
});

test('узел в локальной сети разрешён один — иначе TURN не довёл бы медиа и до своего SFU', () => {
  const rules = peerRules('192.168.10.5');
  assert.deepEqual(rules.allow_restricted_peer_cidrs, ['192.168.10.5/32']);
  assert.equal(permits(rules, '192.168.10.5'), true);
  assert.equal(permits(rules, '192.168.10.6'), false);
  assert.equal(permits(rules, '8.8.8.8'), false);
});

test('«закрытые» адреса — как у Go в LiveKit', () => {
  for (const peer of ['127.0.0.1', '10.1.2.3', '172.31.255.255', '192.168.0.1', '169.254.1.1', '224.0.0.1', '0.0.0.0'])
    assert.equal(restricted(peer), true, peer);
  for (const peer of ['8.8.8.8', '172.32.0.1', '100.64.0.1', '192.0.2.1']) assert.equal(restricted(peer), false, peer);
});

test('узел на IPv6: весь IPv4 закрыт, IPv6 — всё, кроме узла', () => {
  const node = '2001:db8:85a3::8a2e:370:7334';
  const rules = peerRules(node);
  assert.equal(rules.deny_peer_cidrs.length, 129);
  assert.equal(permits(rules, node), true);
  assert.equal(permits(rules, '2001:0db8:85a3:0000:0000:8a2e:0370:7334'), true);
  for (const peer of ['2001:db8:85a3::8a2e:370:7335', '2606:4700::1111', '::1', 'fe80::1', '8.8.8.8', NODE])
    assert.equal(permits(rules, peer), false, peer);
});

test('адрес узла не IP — правила не строятся молча', () => {
  assert.throws(() => complement('example.com'));
  assert.throws(() => peerRules('example.com'));
});
