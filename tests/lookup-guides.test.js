'use strict';
// Guides Lookup builds on the spot (Lookup.Guide) are played to the end in
// the real engine with the shared guide simulator (tools/lib/playtest.js):
// a vendor mount, a drop, a treasure, a dungeon drop, a quest reward behind a
// prerequisite chain, a craft, a reputation reward, and the NPC, quest and
// dungeon kinds. Every one must finish without a stuck step and without an
// accept or turn-in that has no location.
//
// The Codex is the synthetic tests/fixtures/codex/lookup.json. With
// data/forever/map-frames.json present its three maps are moved onto real
// maps with their Era frames (Elwynn Forest, Westfall, Teldrassil); without
// it the fixture's own synthetic frames are used.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { runAddon, ROOT } = require('./helpers/lua');
const { writeCodexPack } = require('./helpers/codex');
const { SIMULATE, luaValue } = require('../tools/lib/playtest');

const FIXTURE = path.join(__dirname, 'fixtures', 'codex', 'lookup.json');
const FRAMES = path.join(ROOT, 'data', 'forever', 'map-frames.json');
const REAL = { 9001: 1429, 9002: 1436, 9003: 1438 };

// The fixture, with its maps moved onto real ones when their frames exist.
function loadCodex() {
	const codex = JSON.parse(fs.readFileSync(FIXTURE, 'utf8'));
	let era = null;
	if (fs.existsSync(FRAMES)) era = JSON.parse(fs.readFileSync(FRAMES, 'utf8')).era || null;
	if (!era || !Object.values(REAL).every((id) => era[id])) return codex;
	const moved = (id) => REAL[id] || id;
	const walk = (v) => {
		if (Array.isArray(v)) return v.forEach(walk);
		if (v && typeof v === 'object') {
			if (typeof v.map === 'number') v.map = moved(v.map);
			Object.values(v).forEach(walk);
		}
	};
	walk(codex.npcs);
	walk(codex.objects);
	walk(codex.instances);
	walk(codex.quests);
	for (const q of Object.values(codex.quests)) q.zone = moved(q.zone);
	codex.frames = Object.fromEntries(Object.keys(codex.frames).map((id) => [moved(Number(id)), era[moved(Number(id))]]));
	codex.zones = Object.fromEntries(Object.values(codex.zones).map((z) => [moved(z.id), { id: moved(z.id), name: z.name }]));
	return codex;
}

const codex = loadCodex();
const HOME = Object.keys(codex.frames).map(Number).sort((a, b) => a - b)[0];
const MAPS = Object.entries(codex.frames)
	.map(([id, f]) => `w.addMap(${id}, { name = ${JSON.stringify(codex.zones[id].name)}, c = ${f.c}, left = ${f.left}, right = ${f.right}, top = ${f.top}, bottom = ${f.bottom} })`)
	.join('\n');

let pack;
before(() => {
	pack = writeCodexPack(codex);
});
after(() => pack && pack.cleanup());

// Builds and opens the guide, describes it, then plays it to the end.
function play(kind, id, { level = 20, setup = '' } = {}) {
	const [built, out] = runAddon({
		stubs: ['stub_world.lua'],
		before: `${pack.stubLua}
local w = stub.world
${MAPS}
w.level = ${level}
w.moveTo(${HOME}, 50, 50)
${setup}`,
		addons: ['Polestar'],
		script: `
stub.login()
Polestar.Set("behavior.autoNextGuide", false)
local id, why = Polestar.Lookup.Guide(${luaValue(kind)}, ${luaValue(id)})
local g = id and Polestar.Guides.Get(id)
local steps = {}
if g then
	for i, s in ipairs(g.steps) do
		local verbs = {}
		for j, goal in ipairs(s.goals) do verbs[j] = goal.t end
		steps[i] = { title = s.title, goals = table.concat(verbs, " ") }
	end
end
emit({ id = id or false, why = why or false, active = Polestar.Engine.GetGuide() and Polestar.Engine.GetGuide().id or false, steps = steps })
stub.advance(0.6)
${SIMULATE}`,
	}).emitted;
	return { built, out };
}

function assertPlays(kind, id, steps, opts) {
	const { built, out } = play(kind, id, opts);
	const gid = `lookup/${kind}/${id}`;
	assert.deepEqual({ id: built.id, active: built.active }, { id: gid, active: gid }, `guide built (${built.why})`);
	assert.deepEqual(built.steps, steps);
	assert.ok(!out.stuck, `stuck: ${JSON.stringify(out.stuck)}`);
	assert.equal(out.done, true);
	assert.deepEqual(out.missing, {}, 'every accept and turn-in has a location');
	assert.equal(out.visited, steps.length);
}

test('a vendor mount: go to the vendor and buy it', () => {
	assertPlays('mount', 8000, [{ title: 'Mira Saddler', goals: 'goto buy' }]);
});

test('a drop: go to the mob, kill it, loot the item', () => {
	assertPlays('item', 8004, [{ title: 'Bristle Boar', goals: 'goto kill collect' }]);
});

test('a treasure: go to the chest and loot it', () => {
	assertPlays('item', 8009, [{ title: 'Weathered Chest', goals: 'goto interact collect' }]);
});

test('a dungeon drop: the entrance first, then the boss', () => {
	assertPlays('item', 8008, [
		{ title: 'Ashen Crypt', goals: 'goto' },
		{ title: 'Lord Ashcroft', goals: 'kill collect' },
	]);
});

test('a quest reward: every prerequisite, one of the any-of ones this character can take, then the quest', () => {
	assertPlays('item', 8001, [
		{ title: 'Trouble in the Vale', goals: 'accept kill collect turnin' },
		{ title: 'Alliance Errand', goals: 'accept turnin' },
		{ title: "The Saddler's Request", goals: 'accept interact complete turnin collect' },
	]);
	// Finished prerequisites are left out.
	assertPlays('item', 8001, [
		{ title: 'Alliance Errand', goals: 'accept turnin' },
		{ title: "The Saddler's Request", goals: 'accept interact complete turnin collect' },
	], { setup: 'w.complete({ 7001 })' });
});

test('an event objective (explore, report) is placed where the data puts it, not at the giver (#515)', () => {
	const [goal] = runAddon({
		stubs: ['stub_world.lua'],
		before: `${pack.stubLua}
local w = stub.world
${MAPS}
w.level = 20
w.moveTo(${HOME}, 50, 50)`,
		addons: ['Polestar'],
		script: `
stub.login()
local id = Polestar.Lookup.Guide("item", 8001)
for _, s in ipairs(Polestar.Guides.Get(id).steps) do
	for _, g in ipairs(s.goals) do
		if g.t == "complete" and g.quest == 7002 then emit({ map = g.map or false, x = g.x or false, y = g.y or false, f = g.f or false }) end
	end
end`,
	}).emitted;
	assert.deepEqual(goal, { map: codex.quests[7002].objectives[1].map, x: 66, y: 40, f: 'e' });
});

test('a beast to tame (Taming the Beast) reads "Tame", not "Kill", and still plays (#565)', () => {
	assertPlays('quest', 7009, [{ title: 'Taming the Beast', goals: 'accept kill turnin' }]);
	const texts = (quest) => runAddon({
		stubs: ['stub_world.lua'],
		before: `${pack.stubLua}
local w = stub.world
${MAPS}
w.level = 20
w.moveTo(${HOME}, 50, 50)`,
		addons: ['Polestar'],
		script: `
stub.login()
Polestar.Set("behavior.autoNextGuide", false)
Polestar.Lookup.Guide("quest", ${quest})
local view = Polestar.Engine.GetStepView(1)
for _, g in ipairs(view.goals) do
	if g.t == "kill" then emit(g.text) end
end`,
	}).emitted;
	assert.deepEqual(texts(7009), ['Tame Bristle Boar']);
	assert.deepEqual(texts(7001), ['Kill Kobold Digger'], 'a plain kill objective still reads "Kill"');
});

test('a craft: learn the profession at its trainer, skill up, learn the recipe, craft', () => {
	assertPlays('item', 8005, [{ title: 'Tailoring', goals: 'train skill learn craft' }]);
	assertPlays('item', 8005, [{ title: 'Tailoring', goals: 'learn craft' }], { setup: 'w.learnSkill(197, "Tailoring", 120, 150)' });
});

test('a reputation reward: reach the standing, then buy it from the quartermaster', () => {
	assertPlays('tabard', 8006, [
		{ title: 'Vale Wardens', goals: 'rep' },
		{ title: 'Quartermaster Ilsa', goals: 'goto buy' },
	]);
});

test('a vendor item behind a standing or a skill rank: reach it first, then buy', () => {
	assertPlays('mount', 8016, [
		{ title: 'Vale Wardens', goals: 'rep' },
		{ title: 'Quartermaster Ilsa', goals: 'goto buy' },
	]);
	assertPlays('recipe', 8017, [
		{ title: 'Tailoring', goals: 'skill' },
		{ title: 'Mira Saddler', goals: 'goto buy' },
	], { setup: 'w.learnSkill(197, "Tailoring", 60, 150)' });
});

test('NPC, quest and dungeon lookups lead there', () => {
	assertPlays('rare', 5011, [{ title: 'Gnash the Unseen', goals: 'goto kill' }]);
	assertPlays('quest', 7001, [{ title: 'Trouble in the Vale', goals: 'accept kill collect turnin' }]);
	assertPlays('instance', 'ashen_crypt', [{ title: 'Ashen Crypt', goals: 'goto' }]);
});
