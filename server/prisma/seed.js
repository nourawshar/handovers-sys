'use strict';
/**
 * Idempotent seed (README §5.1, §11 Phase 0/1). Safe to re-run.
 * docs/SEED_DATA.md did not exist when this was written; data follows the README (sofia example, TR1-TR4, HOSPITAL teams).
 */
require('dotenv').config();
const argon2 = require('argon2');
const prisma = require('../src/db');
const { encrypt } = require('../src/utils/crypto');
const { bumpSequence } = require('../src/services/asset.service');

const pw = (envName, fallback) => process.env[envName] || fallback;
const hash = (p) => argon2.hash(p, { type: argon2.argon2id, memoryCost: 19456, timeCost: 2, parallelism: 1 });

async function upsertCategory(name, parentId, data) {
  const existing = await prisma.assetCategory.findFirst({ where: { name, parentId } });
  if (existing) return prisma.assetCategory.update({ where: { id: existing.id }, data });
  return prisma.assetCategory.create({ data: { name, parentId, ...data } });
}

async function upsertFields(categoryId, fields) {
  let i = 0;
  for (const f of fields) {
    const data = { label: f.label, type: f.type ?? 'string', options: f.options ?? undefined, required: !!f.required, isSearchable: !!f.isSearchable, isIdentifier: !!f.isIdentifier, sortOrder: (i += 10) };
    await prisma.assetCategoryField.upsert({ where: { categoryId_key: { categoryId, key: f.key } }, create: { categoryId, key: f.key, ...data }, update: data });
  }
}

async function upsertAsset({ code, categoryId, phone, custom = {}, fieldMap, ...data }) {
  const asset = await prisma.asset.upsert({ where: { code }, create: { code, categoryId, ...data }, update: { ...data, categoryId } });
  if (phone) await prisma.phoneDetail.upsert({ where: { assetId: asset.id }, create: { assetId: asset.id, ...phone }, update: phone });
  for (const [key, value] of Object.entries(custom)) {
    const fieldId = fieldMap[key];
    await prisma.assetCustomFieldValue.upsert({ where: { assetId_fieldId: { assetId: asset.id, fieldId } }, create: { assetId: asset.id, fieldId, value }, update: { value } });
  }
  return asset;
}

async function main() {
  // ── Departments ──
  const hospital = ['Odeme', 'Muhasebe', 'Banko', 'Dr', 'Asst', 'Satin alma', 'HR (IK)', 'Guvenlik', 'Turcuman', 'Idare isler', 'CEI'];
  const dept = {};
  let order = 0;
  for (const name of hospital) {
    dept[name] = await prisma.departmentTeam.upsert({ where: { name }, create: { name, type: 'HOSPITAL', sortOrder: (order += 10) }, update: { type: 'HOSPITAL' } });
  }
  dept['Call Center'] = await prisma.departmentTeam.upsert({ where: { name: 'Call Center' }, create: { name: 'Call Center', type: 'CALLCENTER', sortOrder: 0 }, update: {} });

  // ── Rooms TR1–TR4 ──
  const rooms = {};
  for (const code of ['TR1', 'TR2', 'TR3', 'TR4']) {
    rooms[code] = await prisma.room.upsert({ where: { code }, create: { code, teamType: 'CALLCENTER' }, update: {} });
  }

  // ── Users ──
  const users = [
    { username: 'admin', fullName: 'System Admin', role: 'ADMIN', password: pw('SEED_ADMIN_PASSWORD', 'Admin#12345') },
    { username: 'manager', fullName: 'IT Manager', role: 'MANAGER', password: pw('SEED_MANAGER_PASSWORD', 'Manager#12345') },
    { username: 'tl.tr1', fullName: 'Team Leader TR1', role: 'TEAM_LEADER', roomId: rooms.TR1.id, password: pw('SEED_TL_PASSWORD', 'Leader#12345') },
    { username: 'tl.tr2', fullName: 'Team Leader TR2', role: 'TEAM_LEADER', roomId: rooms.TR2.id, password: pw('SEED_TL_PASSWORD', 'Leader#12345') },
  ];
  for (const { password, ...u } of users) {
    const existing = await prisma.user.findUnique({ where: { username: u.username } });
    if (existing) {
      // existing passwords are kept unless SEED_RESET_PASSWORDS=true
      const reset = process.env.SEED_RESET_PASSWORDS === 'true' ? { passwordHash: await hash(password) } : {};
      await prisma.user.update({ where: { id: existing.id }, data: { ...u, ...reset } });
    }
    else await prisma.user.create({ data: { ...u, passwordHash: await hash(password) } });
  }

  // ── Employees ──
  const emp = {};
  const employees = [
    ['Sofia Petrova', 'Call Center', 'TR1', 'sofia.petrova@clinic.local'],
    ['Ahmet Yilmaz', 'Call Center', 'TR1', 'ahmet.yilmaz@clinic.local'],
    ['Elif Demir', 'Call Center', 'TR2', 'elif.demir@clinic.local'],
    ['Mehmet Kaya', 'Call Center', 'TR3', 'mehmet.kaya@clinic.local'],
    ['Zeynep Aydin', 'Call Center', 'TR4', 'zeynep.aydin@clinic.local'],
    ['Ayse Celik', 'Banko', null, 'ayse.celik@clinic.local'],
    ['Can Ozturk', 'Muhasebe', null, 'can.ozturk@clinic.local'],
  ];
  for (const [fullName, d, r, internalEmail] of employees) {
    const departmentTeamId = dept[d].id;
    emp[fullName] = await prisma.employee.upsert({
      where: { fullName_departmentTeamId: { fullName, departmentTeamId } },
      create: { fullName, departmentTeamId, roomId: r ? rooms[r].id : null, internalEmail },
      update: { roomId: r ? rooms[r].id : null, internalEmail },
    });
  }
  await prisma.room.update({ where: { code: 'TR1' }, data: { managerEmployeeId: emp['Ahmet Yilmaz'].id } });

  // ── Work identities ──
  const identities = [
    ['sofia', 'TR1'], ['ceo2', 'TR1'], ['coordinator', 'TR2'], ['data_entry', 'TR2'],
    ['seat-tr3-01', 'TR3'], ['seat-tr3-02', 'TR3'], ['seat-tr4-01', 'TR4'],
  ];
  for (const [name, r] of identities) {
    await prisma.workIdentity.upsert({
      where: { name_roomId: { name, roomId: rooms[r].id } },
      create: { name, roomId: rooms[r].id, departmentTeamId: dept['Call Center'].id },
      update: {},
    });
  }

  // ── Categories + custom columns ──
  const phones = await upsertCategory('Phones', null, { kind: 'physical', codePrefix: 'PHN' });
  const sims = await upsertCategory('SIM Cards', null, { kind: 'physical', codePrefix: 'SIM' });
  const laptops = await upsertCategory('Laptops', null, { kind: 'physical', codePrefix: 'LAP' });
  const chargers = await upsertCategory('Chargers', null, { kind: 'physical', codePrefix: 'CHG' });
  const cables = await upsertCategory('Charger Cables', chargers.id, { kind: 'physical', codePrefix: 'CBL' });
  const adapters = await upsertCategory('Charger Adapters', chargers.id, { kind: 'physical', codePrefix: 'ADP' });
  const printers = await upsertCategory('Printers', null, { kind: 'physical', codePrefix: 'PRN' });
  await upsertCategory('Networking', null, { kind: 'physical', codePrefix: 'NET' });
  const accounts = await upsertCategory('Accounts', null, { kind: 'account', codePrefix: 'ACC' });
  await upsertCategory('GMail-for-WhatsApp-Backup', accounts.id, { kind: 'account', codePrefix: 'ACC' });

  await upsertFields(phones.id, [
    { key: 'purchase_date', label: 'Purchase date', type: 'date' },
    { key: 'warranty', label: 'Warranty', type: 'select', options: ['None', '6 months', '1 year', '2 years'] },
    { key: 'screen_protector', label: 'Screen protector fitted', type: 'boolean' },
    { key: 'operating_system', label: 'Operating system' },
    { key: 'battery_health', label: 'Battery health', type: 'select', options: ['Good', 'Fair', 'Poor'] },
  ]);
  await upsertFields(sims.id, [
    { key: 'phone_number', label: 'Phone number', isSearchable: true, isIdentifier: true, required: true },
    { key: 'carrier', label: 'Carrier', type: 'select', options: ['Turkcell', 'Vodafone', 'Turk Telekom', 'Other'] },
    { key: 'plan', label: 'Plan', type: 'string' },
    { key: 'status', label: 'Status', type: 'select', options: ['ACTIVE', 'SUSPENDED', 'DEACTIVATED'] },
  ]);
  await upsertFields(laptops.id, [
    { key: 'model', label: 'Model', isSearchable: true },
    { key: 'cpu', label: 'CPU' },
    { key: 'ram_gb', label: 'RAM (GB)', type: 'number' },
    { key: 'disk', label: 'Disk' },
  ]);
  await upsertFields(printers.id, [
    { key: 'model', label: 'Model', isSearchable: true }, { key: 'pages_delivered', label: 'Pages delivered', type: 'number' },
  ]);

  const fieldMap = {};
  for (const c of [phones, sims, laptops, printers]) {
    for (const f of await prisma.assetCategoryField.findMany({ where: { categoryId: c.id } })) fieldMap[`${c.id}:${f.key}`] = f.id;
  }
  const fm = (cat) => new Proxy({}, { get: (_, k) => fieldMap[`${cat.id}:${k}`] });

  // ── Assets ──
  const A = {};
  const room = (c) => rooms[c].id;
  A.phone1 = await upsertAsset({ code: 'PHN-000001', categoryId: phones.id, name: 'Samsung Galaxy A12', serialNumber: 'R58N30ABCDE', condition: 'GOOD', roomId: room('TR1'), phone: { imei: '356938035643809', make: 'Samsung', model: 'Galaxy A12', color: 'Black', storage: '64 GB', operatingSystem: 'Android 12', appBinary: 'BUSINESS' }, custom: { warranty: '1 year', screen_protector: true }, fieldMap: fm(phones) });
  A.phone2 = await upsertAsset({ code: 'PHN-000002', categoryId: phones.id, name: 'Samsung Galaxy A12', serialNumber: 'R58N30FGHIJ', condition: 'NEW', roomId: room('TR1'), phone: { imei: '356938035643817', make: 'Samsung', model: 'Galaxy A12', color: 'White', storage: '64 GB', operatingSystem: 'Android 12', appBinary: 'NORMAL' }, fieldMap: fm(phones) });
  A.phone3 = await upsertAsset({ code: 'PHN-000003', categoryId: phones.id, name: 'Xiaomi Redmi Note 11', condition: 'FAIR', roomId: room('TR2'), phone: { imei: '861234567890123', make: 'Xiaomi', model: 'Redmi Note 11', color: 'Blue', storage: '128 GB', operatingSystem: 'Android 13', appBinary: 'BUSINESS' }, fieldMap: fm(phones) });
  A.phone4 = await upsertAsset({ code: 'PHN-000004', categoryId: phones.id, name: 'iPhone 11', condition: 'GOOD', status: 'IN_REPAIR', phone: { imei: '353456789012345', make: 'Apple', model: 'iPhone 11', color: 'Black', storage: '128 GB', operatingSystem: 'iOS 17', appBinary: 'NORMAL' }, notes: 'Cracked screen, waiting for repair', fieldMap: fm(phones) });
  A.phone5 = await upsertAsset({ code: 'PHN-000005', categoryId: phones.id, name: 'Samsung Galaxy A13', condition: 'GOOD', roomId: room('TR3'), phone: { imei: '350000000000011', make: 'Samsung', model: 'Galaxy A13', color: 'Black', storage: '64 GB', operatingSystem: 'Android 13', appBinary: 'NORMAL' }, fieldMap: fm(phones) });

  const simRows = [['905369700889', 'Turkcell'], ['905369700890', 'Turkcell'], ['905321112233', 'Vodafone'], ['905441234567', 'Turk Telekom']];
  let n = 0;
  for (const [num, carrier] of simRows) {
    await upsertAsset({ code: `SIM-${String((n += 1)).padStart(6, '0')}`, categoryId: sims.id, name: `SIM ${num}`, serialNumber: `8990${num}`, condition: 'NEW', custom: { phone_number: num, carrier, status: 'ACTIVE' }, fieldMap: fm(sims) });
  }
  await upsertAsset({ code: 'LAP-000001', categoryId: laptops.id, name: 'Lenovo ThinkPad E14', serialNumber: 'PF3ABCDE', condition: 'GOOD', custom: { model: 'ThinkPad E14', cpu: 'Intel i5-1135G7', ram_gb: 16, disk: '512 GB NVMe' }, fieldMap: fm(laptops) });
  await upsertAsset({ code: 'PRN-000001', categoryId: printers.id, name: 'HP LaserJet Pro M404', condition: 'GOOD', roomId: room('TR1'), custom: { model: 'M404dn', pages_delivered: 18250 }, fieldMap: fm(printers) });
  for (let i = 1; i <= 3; i += 1) {
    await upsertAsset({ code: `CBL-${String(i).padStart(6, '0')}`, categoryId: cables.id, name: 'USB-C charger cable', condition: i === 3 ? 'FAIR' : 'GOOD', fieldMap: {} });
    await upsertAsset({ code: `ADP-${String(i).padStart(6, '0')}`, categoryId: adapters.id, name: '15W USB adapter', condition: i === 3 ? 'POOR' : 'GOOD', fieldMap: {} });
  }
  for (const [p, max] of [['PHN', 5], ['SIM', 4], ['LAP', 1], ['PRN', 1], ['CBL', 3], ['ADP', 3]]) await bumpSequence(p, max);

  // ── Accounts (credentials AES-256-GCM encrypted) ──
  const acc = [
    { kind: 'GMAIL', identifier: 'class3447@gmail.com', email: 'class3447@gmail.com', subcategory: 'GMail for WhatsApp backup', isWhatsAppBackup: true, password: 'Seed-Gmail-Pass-1!' },
    { kind: 'GMAIL', identifier: 'class3448@gmail.com', email: 'class3448@gmail.com', subcategory: 'GMail for WhatsApp backup', isWhatsAppBackup: true, password: 'Seed-Gmail-Pass-2!' },
    { kind: 'WHATSAPP', identifier: '905369700889', subcategory: 'WhatsApp Business', password: 'n/a-whatsapp-uses-sms' },
    { kind: 'BITRIX', identifier: 'sofia@clinic.bitrix24.com', email: 'sofia@clinic.bitrix24.com', password: 'Seed-Bitrix-Pass-1!' },
    { kind: 'BITRIX', identifier: 'ceo2@clinic.bitrix24.com', email: 'ceo2@clinic.bitrix24.com', password: 'Seed-Bitrix-Pass-2!' },
  ];
  for (const { password, ...a } of acc) {
    await prisma.account.upsert({ where: { kind_identifier: { kind: a.kind, identifier: a.identifier } }, create: { ...a, passwordEnc: encrypt(password) }, update: a });
  }

  const counts = await Promise.all([prisma.user.count(), prisma.departmentTeam.count(), prisma.room.count(), prisma.workIdentity.count(), prisma.employee.count(), prisma.assetCategory.count(), prisma.asset.count(), prisma.account.count()]);
  console.log('Seed complete:', Object.fromEntries(['users', 'departments', 'rooms', 'workIdentities', 'employees', 'categories', 'assets', 'accounts'].map((k, i) => [k, counts[i]])));
  console.log('Logins: admin / manager / tl.tr1 / tl.tr2 (passwords from SEED_*_PASSWORD env, see server/README.md)');
}

main()
  .catch((e) => { console.error(e); process.exit(1); })
  .finally(() => prisma.$disconnect());
