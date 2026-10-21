'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { emitGuides } = require('../tools/lib/dsl/emit');
const { runAddon } = require('./helpers/lua');
const { TEST_PACK, TEST_SOURCE } = require('./helpers/packs');

test('emitted repeated candidates share data but keep selection local to each goal', () => {
	const candidates = [
		{ npc: 295, npcName: 'First innkeeper', map: 1429, x: 10, y: 10 },
		{ npc: 296, npcName: 'Second innkeeper', map: 1429, x: 90, y: 90 },
	];
	const guide = {
		id: 'test/shared-candidates', pack: 'test', title: 'Shared candidates', minLevel: 1, maxLevel: 60,
		steps: [
			{ goals: [{ t: 'sethome', candidates: structuredClone(candidates) }] },
			{ goals: [{ t: 'sethome', candidates: structuredClone(candidates) }] },
			{ goals: [{ t: 'sethome', candidates: [{ ...candidates[0], x: 11 }, candidates[1]] }] },
			{ goals: [{ t: 'sethome', candidates: [candidates[1], candidates[1], { ...candidates[1], rate: 0.5 }] }] },
		],
	};
	const [out] = runAddon({
		stubs: ['stub_world.lua'],
		before: 'local w=stub.world; w.addMap(1429,{name="Elwynn Forest",c=0,left=1000,right=-1000,top=1000,bottom=-1000}); w.moveTo(1429,10,10)',
		addons: [{ name: 'Polestar', files: ['Core/Core.xml'] }],
		script: `${TEST_PACK}\n${TEST_SOURCE}\n${emitGuides([{ guide }])}
			stub.login(); local E=Polestar.Engine; E.SetGuide("test/shared-candidates")
			local g=Polestar.Guides.Get("test/shared-candidates")
			local a,b,c=g.steps[1].goals[1],g.steps[2].goals[1],g.steps[3].goals[1]
			local result={shared=a.candidates==b.candidates,different=a.candidates~=c.candidates,distinctGoals=a~=b,
				sharedRecord=a.candidates[2]==c.candidates[2],differentRecord=a.candidates[1]~=c.candidates[1]}
			local d=g.steps[4].goals[1].candidates
			result.distinctEntries=d[1]~=d[2]
			result.differentRate=d[1]~=d[3] and d[3].rate==0.5
			result.before={E.GetStepView(1).goals[1].npc,E.GetStepView(2).goals[1].npc}
			E.CycleCandidate(1,1)
			result.after={E.GetStepView(1).goals[1].npc,E.GetStepView(2).goals[1].npc}
			result.sourceOrder={a.candidates[1].npc,a.candidates[2].npc}
			emit(result)`,
	}).emitted;
	assert.equal(out.shared, true);
	assert.equal(out.different, true);
	assert.equal(out.distinctGoals, true);
	assert.equal(out.sharedRecord, true, 'identical records in different lists share storage');
	assert.equal(out.differentRecord, true, 'same NPC with different coordinates stays distinct');
	assert.equal(out.distinctEntries, true, 'ranking keeps duplicate entries in one list distinct');
	assert.equal(out.differentRate, true, 'same NPC with a different drop rate stays distinct');
	assert.deepEqual(out.before, [295, 295]);
	assert.deepEqual(out.after, [296, 295]);
	assert.deepEqual(out.sourceOrder, [295, 296]);
});

test('candidate sharing stays inside one guide and leaves spawn visitation separate', () => {
	const candidate = { npc: 295, npcName: 'Innkeeper', map: 1429, x: 10, y: 10 };
	const make = (id, faction) => ({
		id, pack: 'test', title: id, faction, minLevel: 1, maxLevel: 60,
		steps: [
			{ goals: [
				{ t: 'sethome', candidates: [candidate] },
				{ t: 'kill', target: 'Test target', npc: 295, npcName: 'Test target', map: 1429, x: 10, y: 10, spots: [{ x: 10, y: 10, r: 20, n: 2 }] },
			] },
			{ goals: [
				{ t: 'sethome', candidates: [candidate] },
				{ t: 'kill', target: 'Test target', npc: 295, npcName: 'Test target', map: 1429, x: 10, y: 10, spots: [{ x: 10, y: 10, r: 20, n: 2 }] },
			] },
		],
	});
	const [out] = runAddon({
		stubs: ['stub_world.lua'],
		addons: [{ name: 'Polestar', files: ['Core/Core.xml'] }],
		script: `
			${TEST_PACK}\n${TEST_SOURCE}\n${emitGuides([{ guide: make('test/horde', 'Horde') }, { guide: make('test/alliance', 'Alliance') }])}
			stub.login()
			local a,b=Polestar.Guides.Get('test/horde'),Polestar.Guides.Get('test/alliance')
			emit({inside=a.steps[1].goals[1].candidates==a.steps[2].goals[1].candidates,
				separate=a.steps[1].goals[1].candidates[1]~=b.steps[1].goals[1].candidates[1],
				visits=a.steps[1].goals[2].spots[1]~=a.steps[2].goals[2].spots[1]})`,
	}).emitted;
	assert.deepEqual(out, { inside: true, separate: true, visits: true });
});
