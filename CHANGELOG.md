# Changelog

## [0.1.8](https://github.com/knowttl/vectra-axi/compare/v0.1.7...v0.1.8) (2026-10-22)


### Features

* **cli:** accept the resource id as a positional argument ([#61](https://github.com/knowttl/vectra-axi/issues/61)) ([505809f](https://github.com/knowttl/vectra-axi/commit/505809f0430058a864ef17da6a2c75d14ede3d82))
* complete bounded traversal for collection lists ([#55](https://github.com/knowttl/vectra-axi/issues/55)) ([97a8563](https://github.com/knowttl/vectra-axi/commit/97a85631c8fb8cf0c1b1a2f19dd18e9922b19acf))
* **detections:** decode detection timing, source, summary and target fields ([#60](https://github.com/knowttl/vectra-axi/issues/60)) ([a4faa2d](https://github.com/knowttl/vectra-axi/commit/a4faa2d9b88ed6122a7f262fd53878196b312301))
* **entities:** filter host list by name ([#62](https://github.com/knowttl/vectra-axi/issues/62)) ([cde9099](https://github.com/knowttl/vectra-axi/commit/cde9099918e82cb6b4b0fae2b15240f7d521e8bc))


### Bug Fixes

* **cli:** refresh Vectra README and generated command reference ([#59](https://github.com/knowttl/vectra-axi/issues/59)) ([25057e4](https://github.com/knowttl/vectra-axi/commit/25057e4c43b31c021be86e9353655deb8eb9e8df))
* **cli:** scope command help and repair installed skill guidance ([#58](https://github.com/knowttl/vectra-axi/issues/58)) ([ca01eff](https://github.com/knowttl/vectra-axi/commit/ca01effe2a1723ea0ebf7eb9336788cc39ea88ca))

## [0.1.7](https://github.com/knowttl/vectra-axi/compare/v0.1.6...v0.1.7) (2026-10-18)


### Features

* add bounded --all traversal for detection and entity lists ([#54](https://github.com/knowttl/vectra-axi/issues/54)) ([50e9559](https://github.com/knowttl/vectra-axi/commit/50e9559c9101254689934a8dcc1dd2b812d68b14))


### Bug Fixes

* describe reviewed RUX support in command help ([#52](https://github.com/knowttl/vectra-axi/issues/52)) ([323d973](https://github.com/knowttl/vectra-axi/commit/323d9738434394fd6711798b00d7b5b62bb5625b))

## [0.1.6](https://github.com/knowttl/vectra-axi/compare/v0.1.5...v0.1.6) (2026-10-16)


### Features

* show skill-install hint on bare home view when skill is missing ([0f037ea](https://github.com/knowttl/vectra-axi/commit/0f037ea715b7d90aa6fb5c68c0417f7035a93cd3))

## [0.1.5](https://github.com/knowttl/vectra-axi/compare/v0.1.4...v0.1.5) (2026-10-13)


### Miscellaneous Chores

* release 0.1.5 ([1a4b507](https://github.com/knowttl/vectra-axi/commit/1a4b507baf91e7f7ac259d28b9e80d3b3403ad46))

## [0.1.4](https://github.com/knowttl/vectra-axi/compare/v0.1.3...v0.1.4) (2026-10-12)


### Features

* adopt AXI credential profiles and private file protection ([#45](https://github.com/knowttl/vectra-axi/issues/45)) ([a4940da](https://github.com/knowttl/vectra-axi/commit/a4940daec739db8ffe411c205ff9ebeb9eb08431))


### Bug Fixes

* guard persistent hooks against disposable build targets ([#43](https://github.com/knowttl/vectra-axi/issues/43)) ([12bd939](https://github.com/knowttl/vectra-axi/commit/12bd9395da57358ef3aa01256014a23d4b57aa03))

## [0.1.3](https://github.com/knowttl/vectra-axi/compare/v0.1.2...v0.1.3) (2026-10-05)


### Features

* add opt-in session-start hook with local-only summary ([#40](https://github.com/knowttl/vectra-axi/issues/40)) ([cf6b116](https://github.com/knowttl/vectra-axi/commit/cf6b116beb8c7f3aaf4cf9f0668939cb992ba89f))

## [0.1.2](https://github.com/knowttl/vectra-axi/compare/v0.1.1...v0.1.2) (2026-10-05)


### Features

* add gated QUX and RUX note edits and deletes ([#32](https://github.com/knowttl/vectra-axi/issues/32)) ([e2c3fa3](https://github.com/knowttl/vectra-axi/commit/e2c3fa37685c904273e0496e375e5c466bb9254e))
* add reviewed raw API reads ([#36](https://github.com/knowttl/vectra-axi/issues/36)) ([276ce6e](https://github.com/knowttl/vectra-axi/commit/276ce6e8bcaac7bba8de154699ddc311f7e2c9a7))

## [0.1.1](https://github.com/knowttl/vectra-axi/compare/v0.1.0...v0.1.1) (2026-10-05)


### Features

* add assignment, outcome and user reads ([#11](https://github.com/knowttl/vectra-axi/issues/11)) ([c5e1dab](https://github.com/knowttl/vectra-axi/commit/c5e1dab8810050b7045fba17835f2d625abf1de3))
* add bounded collection reads with retries and cancellation ([#7](https://github.com/knowttl/vectra-axi/issues/7)) ([2b4af30](https://github.com/knowttl/vectra-axi/commit/2b4af300da91b9ae8912881c42f910deb6ff72d9))
* add bounded QUX audit reads ([#12](https://github.com/knowttl/vectra-axi/issues/12)) ([703615b](https://github.com/knowttl/vectra-axi/commit/703615b9011d96242fb84b55fb3bd4f7adf300f3))
* add detection list and show commands ([#8](https://github.com/knowttl/vectra-axi/issues/8)) ([c8db788](https://github.com/knowttl/vectra-axi/commit/c8db788aee429475b983528c01f19eb3928b32ce))
* add fixture-only mutation coordinator ([#17](https://github.com/knowttl/vectra-axi/issues/17)) ([0922c4e](https://github.com/knowttl/vectra-axi/commit/0922c4e4356216adc5119ce1752a4c0dbc149974))
* add gated bulk tag set and delete commands ([#34](https://github.com/knowttl/vectra-axi/issues/34)) ([6ac31e7](https://github.com/knowttl/vectra-axi/commit/6ac31e784a67325e815d8a63d403b0113b54c6e4))
* add gated desired-state tag replacement ([#19](https://github.com/knowttl/vectra-axi/issues/19)) ([a3bff01](https://github.com/knowttl/vectra-axi/commit/a3bff011f76120cb32f57792fdf12c305392aded))
* add gated QUX host and account assignment changes ([#28](https://github.com/knowttl/vectra-axi/issues/28)) ([4b4d1c5](https://github.com/knowttl/vectra-axi/commit/4b4d1c54a36183f6d625e2aefa9d0dbfd669f748))
* add gated QUX note append commands ([#21](https://github.com/knowttl/vectra-axi/issues/21)) ([de1ced8](https://github.com/knowttl/vectra-axi/commit/de1ced86506db7d99deb0cc26f0b0f261f0a0361))
* add profile doctor checks and read-release packaging ([#16](https://github.com/knowttl/vectra-axi/issues/16)) ([1cb6dc2](https://github.com/knowttl/vectra-axi/commit/1cb6dc288e4b1a12483720299936a8bfb8725d2a))
* add QUX group, member, and triage rule reads ([#13](https://github.com/knowttl/vectra-axi/issues/13)) ([20f4af8](https://github.com/knowttl/vectra-axi/commit/20f4af82e5470f98446391bcaaa458b31f32a489))
* add QUX health snapshots and checkpoint event reads ([#14](https://github.com/knowttl/vectra-axi/issues/14)) ([84abfa8](https://github.com/knowttl/vectra-axi/commit/84abfa849e0317604e2f16044d62a8740540da1f))
* add QUX host, account and type-qualified entity reads ([#9](https://github.com/knowttl/vectra-axi/issues/9)) ([c9acc45](https://github.com/knowttl/vectra-axi/commit/c9acc45b5ad72ecc878e8a4fe5dce546ba1f0f46))
* add QUX OAuth client-credentials support ([#5](https://github.com/knowttl/vectra-axi/issues/5)) ([209d339](https://github.com/knowttl/vectra-axi/commit/209d339416307aef504c0b82197baa5b4c07fc19))
* add QUX read session and bounded HTTP transport ([#6](https://github.com/knowttl/vectra-axi/issues/6)) ([c25b194](https://github.com/knowttl/vectra-axi/commit/c25b194a8e70df04b849be611261f08a9eac29dc))
* add QUX token profiles and TLS authentication primitives ([#4](https://github.com/knowttl/vectra-axi/issues/4)) ([f93e287](https://github.com/knowttl/vectra-axi/commit/f93e287f2aba0347643f53075b40ac6a000c4d7d))
* add read-only detection, host and account notes and tags ([#10](https://github.com/knowttl/vectra-axi/issues/10)) ([2ec6f5b](https://github.com/knowttl/vectra-axi/commit/2ec6f5b4e2b025f0ff70582aa2c3795bb45ef483))
* add read-only host and account lockdown status ([#15](https://github.com/knowttl/vectra-axi/issues/15)) ([66228c0](https://github.com/knowttl/vectra-axi/commit/66228c03ac73ffeba0452ad0511e2a18006545cd))
* add RUX assignment, outcome, and user reads ([#25](https://github.com/knowttl/vectra-axi/issues/25)) ([7f1a805](https://github.com/knowttl/vectra-axi/commit/7f1a805a26bafb3620013c979d14c6ef507757cb))
* add RUX audit-event reads ([#31](https://github.com/knowttl/vectra-axi/issues/31)) ([634ac21](https://github.com/knowttl/vectra-axi/commit/634ac21ea24b13c13ce9f46daafa4953fbc95d82))
* add RUX connector, EDR, and network-brain health reads ([#29](https://github.com/knowttl/vectra-axi/issues/29)) ([b06c1d9](https://github.com/knowttl/vectra-axi/commit/b06c1d9e20ebab178a8d1c601ebe657f5a3a00c5))
* add RUX detection and entity reads ([#20](https://github.com/knowttl/vectra-axi/issues/20)) ([b55fc89](https://github.com/knowttl/vectra-axi/commit/b55fc897910a3ebd257dba67e5daf5387e9ff237))
* add RUX detection event reads with checkpoint continuation ([#27](https://github.com/knowttl/vectra-axi/issues/27)) ([0aa85cf](https://github.com/knowttl/vectra-axi/commit/0aa85cfb9f7e71bebb65ceeae4acde1a7c3da0bc))
* add RUX entity scoring event reads ([#30](https://github.com/knowttl/vectra-axi/issues/30)) ([00f09ee](https://github.com/knowttl/vectra-axi/commit/00f09ee902b1693d6b6c212cb660c3a6711317f9))
* add RUX group, membership and triage rule reads ([#22](https://github.com/knowttl/vectra-axi/issues/22)) ([c2ac276](https://github.com/knowttl/vectra-axi/commit/c2ac276c9b99ad6896fdce0a6741db88aa619fff))
* add RUX health and lockdown status reads ([#26](https://github.com/knowttl/vectra-axi/issues/26)) ([6731afe](https://github.com/knowttl/vectra-axi/commit/6731afed7938165d85a02e4b5dcef58a43159c3c))
* add RUX note and tag reads ([#23](https://github.com/knowttl/vectra-axi/issues/23)) ([2033214](https://github.com/knowttl/vectra-axi/commit/20332144af809df3af0de0b1fba79812a0ebf8cb))
* add RUX v3.4 OAuth and base session support ([#18](https://github.com/knowttl/vectra-axi/issues/18)) ([59fd7d8](https://github.com/knowttl/vectra-axi/commit/59fd7d8d1da858e0966779c1cf34d28c5a392f08))
* add vectra-axi CLI shell and strict command catalogue ([#3](https://github.com/knowttl/vectra-axi/issues/3)) ([184a57a](https://github.com/knowttl/vectra-axi/commit/184a57a80259c68b95aad3674919ed2fd4a08e14))
* enable automated npm releases for vectra-axi ([#33](https://github.com/knowttl/vectra-axi/issues/33)) ([48b0e84](https://github.com/knowttl/vectra-axi/commit/48b0e84fc8ffbf7c6f1679c318023f80f4e59037))
