# Changelog

## [0.1.14](https://github.com/knowttl/vectra-axi/compare/v0.1.13...v0.1.14) (2026-10-31)


### Features

* list detections by host name ([#109](https://github.com/knowttl/vectra-axi/issues/109)) ([3e81ae1](https://github.com/knowttl/vectra-axi/commit/3e81ae1fd866a324bf46a7ef6490c54e2751c346))


### Bug Fixes

* replace startup catalog dump with bounded live detection context ([#107](https://github.com/knowttl/vectra-axi/issues/107)) ([3fbbc69](https://github.com/knowttl/vectra-axi/commit/3fbbc695bcaac6ac2894f9e18ef0a3f17e7f4fac))

## [0.1.13](https://github.com/knowttl/vectra-axi/compare/v0.1.12...v0.1.13) (2026-10-30)


### Bug Fixes

* preserve safe diagnostics for invalid upstream responses ([#104](https://github.com/knowttl/vectra-axi/issues/104)) ([d6aae56](https://github.com/knowttl/vectra-axi/commit/d6aae56ed82576ac07b8d9179851d4946d7b8ba1))
* report incomplete results while continuation cursors remain ([#102](https://github.com/knowttl/vectra-axi/issues/102)) ([2fb2eb9](https://github.com/knowttl/vectra-axi/commit/2fb2eb924f3a16352140dc43bca6ec320bf04f23))

## [0.1.12](https://github.com/knowttl/vectra-axi/compare/v0.1.11...v0.1.12) (2026-10-28)


### Bug Fixes

* align README and CLI help with the axi documentation standard ([#96](https://github.com/knowttl/vectra-axi/issues/96)) ([669f518](https://github.com/knowttl/vectra-axi/commit/669f5188274cf53fae14825db806fb85561e9c5c))
* guide agents through bounded read-only investigations ([#100](https://github.com/knowttl/vectra-axi/issues/100)) ([e603b85](https://github.com/knowttl/vectra-axi/commit/e603b85f6b48ec84231dfdcd82ea24f91b958dce))

## [0.1.11](https://github.com/knowttl/vectra-axi/compare/v0.1.10...v0.1.11) (2026-10-28)


### Bug Fixes

* **detections:** expose triage and assignment context ([#95](https://github.com/knowttl/vectra-axi/issues/95)) ([07e02e4](https://github.com/knowttl/vectra-axi/commit/07e02e48ed5f5f8a1aa0e033119ef2e4643ef527))
* restore QUX collection pagination and reject zero IDs ([#93](https://github.com/knowttl/vectra-axi/issues/93)) ([b2a0db5](https://github.com/knowttl/vectra-axi/commit/b2a0db5e245aed3bb5a5d956dab614f7d611f638))

## [0.1.10](https://github.com/knowttl/vectra-axi/compare/v0.1.9...v0.1.10) (2026-10-27)


### Features

* **entities:** return all host fields in host show with full-text flag ([#91](https://github.com/knowttl/vectra-axi/issues/91)) ([28ff860](https://github.com/knowttl/vectra-axi/commit/28ff860f25b0a17ecdcf874286d1d9d40f93ae56))

## [0.1.9](https://github.com/knowttl/vectra-axi/compare/v0.1.8...v0.1.9) (2026-10-23)


### Features

* add gated assignment outcome create, edit, and delete ([#73](https://github.com/knowttl/vectra-axi/issues/73)) ([dcc6c54](https://github.com/knowttl/vectra-axi/commit/dcc6c5477c37de823d7d41b7493ba2cf24c585a2))
* add gated host key-asset set command ([#72](https://github.com/knowttl/vectra-axi/issues/72)) ([281c399](https://github.com/knowttl/vectra-axi/commit/281c399062d68ca4765e9ab2d1e7f4a60ee0a644))
* add gated RUX bulk note appends for detections, hosts, and accounts ([#82](https://github.com/knowttl/vectra-axi/issues/82)) ([76c0e28](https://github.com/knowttl/vectra-axi/commit/76c0e28c1e0f45c96fa4ae07b8345a697a31d5ac))
* add gated triage rule create, edit, and delete ([#77](https://github.com/knowttl/vectra-axi/issues/77)) ([574221b](https://github.com/knowttl/vectra-axi/commit/574221ba9aefc60f67480df7e9921b5e8494e655))
* **assignments:** add gated assignment resolve for hosts and accounts ([#76](https://github.com/knowttl/vectra-axi/issues/76)) ([dfbc817](https://github.com/knowttl/vectra-axi/commit/dfbc81732134600d3d3c1e4ecde487956ddeccb2))
* **detections:** add gated detection close and reopen commands ([#70](https://github.com/knowttl/vectra-axi/issues/70)) ([98104c2](https://github.com/knowttl/vectra-axi/commit/98104c2f64771b4d4e9b9bd3617e97322c0a1e15))
* **detections:** add gated detection fixed set command ([#79](https://github.com/knowttl/vectra-axi/issues/79)) ([09283ae](https://github.com/knowttl/vectra-axi/commit/09283ae7cd9f58955bdb95c1876bac5a3657d2b9))
* **detections:** add gated detection triage set and clear ([#75](https://github.com/knowttl/vectra-axi/issues/75)) ([38e714c](https://github.com/knowttl/vectra-axi/commit/38e714cd4f8dd8add64cb44fbd58ae7e8dab2648))
* enable RUX detection, host, and account tag writes ([#63](https://github.com/knowttl/vectra-axi/issues/63)) ([063f598](https://github.com/knowttl/vectra-axi/commit/063f5987957792574739ea3dd287f698b79a21c6))
* **entities:** add gated host and account close commands ([#71](https://github.com/knowttl/vectra-axi/issues/71)) ([8bbfc5d](https://github.com/knowttl/vectra-axi/commit/8bbfc5d0d5d6dc3e37f0525a2aca6675e478564c))
* **groups:** add gated group create, edit, and delete ([#81](https://github.com/knowttl/vectra-axi/issues/81)) ([d72b85a](https://github.com/knowttl/vectra-axi/commit/d72b85a04b51a1f65a3e8ffda0aa6ea89964d67b))
* **groups:** add gated group member add, remove, and set commands ([#78](https://github.com/knowttl/vectra-axi/issues/78)) ([c1074c6](https://github.com/knowttl/vectra-axi/commit/c1074c6ef1886ac909476e9e2c720d8ce3afdfec))
* **match:** add Match reads and gated enablement, ruleset, and assignment writes ([#89](https://github.com/knowttl/vectra-axi/issues/89)) ([409a06f](https://github.com/knowttl/vectra-axi/commit/409a06f0d32ea00769162c7750dcec4fac04f986))
* **notifications:** add gated RUX notification destination management ([#90](https://github.com/knowttl/vectra-axi/issues/90)) ([c2c0da4](https://github.com/knowttl/vectra-axi/commit/c2c0da47fbec9abc2b712dc6bce773ee4091caef))
* **proxies:** add proxy reads and gated proxy writes ([#84](https://github.com/knowttl/vectra-axi/issues/84)) ([1f7d509](https://github.com/knowttl/vectra-axi/commit/1f7d509501b2c2e6590e676ddeeffa7847ed7f00))
* **settings:** add gated QUX internal-network show and set ([#86](https://github.com/knowttl/vectra-axi/issues/86)) ([d05d310](https://github.com/knowttl/vectra-axi/commit/d05d310ce0307a273ba995ab70c91a67c8ac5be0))
* **settings:** add gated QUX syslog and Kafka export set ([#87](https://github.com/knowttl/vectra-axi/issues/87)) ([680b35c](https://github.com/knowttl/vectra-axi/commit/680b35cfed3b530c062586808a9e92d7daa2c9c8))
* support RUX assignment sets through the gated write pipeline ([#69](https://github.com/knowttl/vectra-axi/issues/69)) ([9b53a3b](https://github.com/knowttl/vectra-axi/commit/9b53a3bddc0084a07e94ec933195537fa9c12212))
* support RUX note appends through the gated write pipeline ([#66](https://github.com/knowttl/vectra-axi/issues/66)) ([e40b348](https://github.com/knowttl/vectra-axi/commit/e40b3488d8b47134c4b95eef8e95ee86afd3eeea))
* **threat-feeds:** add threat-feed reads and gated writes ([#85](https://github.com/knowttl/vectra-axi/issues/85)) ([02f8412](https://github.com/knowttl/vectra-axi/commit/02f84124a1d336a5e37789f8022670fb15a97c5f))

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
