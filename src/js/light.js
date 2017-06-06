var bFsInitialized = false;
var BLACKBYTES_ASSET = require('byteballcore/constants').BLACKBYTES_ASSET;

function initWallet() {
	var root = {};
	root.profile = null;
	root.focusedClient = null;
	root.walletClients = {};
	root.config = null;

	var decryptOnMobile = function(text, cb) {
		var json;
		try {
			json = JSON.parse(text);
		} catch (e) {
		}

		if (!json) return cb('Could not access storage');

		if (!json.iter || !json.ct) {
			return cb(null, text);
		}
		return cb(null, text);
	};

	function createObjProfile(profile) {
		profile = JSON.parse(profile);
		var Profile = {};
		Profile.version = '1.0.0';
		Profile.createdOn = profile.createdOn;
		Profile.credentials = profile.credentials;

		if (Profile.credentials[0] && typeof Profile.credentials[0] !== 'object')
			throw ("credentials should be an object");

		if (!profile.xPrivKey && !profile.xPrivKeyEncrypted)
			throw Error("no xPrivKey, even encrypted");
		if (!profile.tempDeviceKey)
			throw Error("no tempDeviceKey");
		Profile.xPrivKey = profile.xPrivKey;
		Profile.mnemonic = profile.mnemonic;
		Profile.xPrivKeyEncrypted = profile.xPrivKeyEncrypted;
		Profile.mnemonicEncrypted = profile.mnemonicEncrypted;
		Profile.tempDeviceKey = profile.tempDeviceKey;
		Profile.prevTempDeviceKey = profile.prevTempDeviceKey; // optional
		Profile.my_device_address = profile.my_device_address;
		return Profile;
	}

	function setWalletClients(credentials) {
		if (root.walletClients[credentials.walletId] && root.walletClients[credentials.walletId].started)
			return;

		var client = {credentials: credentials};

		client.credentials.xPrivKey = root.profile.xPrivKey;
		client.credentials.mnemonic = root.profile.mnemonic;
		client.credentials.xPrivKeyEncrypted = root.profile.xPrivKeyEncrypted;
		client.credentials.mnemonicEncrypted = root.profile.mnemonicEncrypted;

		root.walletClients[credentials.walletId] = client;
		root.walletClients[credentials.walletId].started = true;
	}

	function readBalance(wallet, handleBalance) {
		var db = require('byteballcore/db');
		var walletIsAddress = typeof wallet === 'string' && wallet.length === 32;
		var join_my_addresses = walletIsAddress ? "" : "JOIN my_addresses USING(address)";
		var where_condition = walletIsAddress ? "address=?" : "wallet=?";
		var assocBalances = {base: {stable: 0, pending: 0}};
		db.query(
			"SELECT asset, is_stable, SUM(amount) AS balance \n\
			FROM outputs " + join_my_addresses + " CROSS JOIN units USING(unit) \n\
		WHERE is_spent=0 AND " + where_condition + " AND sequence='good' \n\
		GROUP BY asset, is_stable",
			[wallet],
			function(rows) {
				for (var i = 0; i < rows.length; i++) {
					var row = rows[i];
					var asset = row.asset || "base";
					if (!assocBalances[asset])
						assocBalances[asset] = {stable: 0, pending: 0};
					assocBalances[asset][row.is_stable ? 'stable' : 'pending'] = row.balance;
				}
				var my_addresses_join = walletIsAddress ? "" : "my_addresses CROSS JOIN";
				var using = walletIsAddress ? "" : "USING(address)";
				db.query(
					"SELECT SUM(total) AS total FROM ( \n\
					SELECT SUM(amount) AS total FROM " + my_addresses_join + " witnessing_outputs " + using + " WHERE is_spent=0 AND " + where_condition + " \n\
				UNION ALL \n\
				SELECT SUM(amount) AS total FROM " + my_addresses_join + " headers_commission_outputs " + using + " WHERE is_spent=0 AND " + where_condition + " )",
					[wallet, wallet],
					function(rows) {
						if (rows.length) {
							assocBalances["base"]["stable"] += rows[0].total;
						}
						// add 0-balance assets
						db.query(
							"SELECT DISTINCT outputs.asset, is_private \n\
							FROM outputs " + join_my_addresses + " CROSS JOIN units USING(unit) LEFT JOIN assets ON asset=assets.unit \n\
						WHERE " + where_condition + " AND sequence='good'",
							[wallet],
							function(rows) {
								for (var i = 0; i < rows.length; i++) {
									var row = rows[i];
									var asset = row.asset || "base";
									if (!assocBalances[asset])
										assocBalances[asset] = {stable: 0, pending: 0};
									assocBalances[asset].is_private = row.is_private;
								}
								handleBalance(assocBalances);
							}
						);
					}
				);
			}
		);
	}

	function readSharedBalance(wallet, handleBalance) {
		var db = require('byteballcore/db');
		var assocBalances = {};

		db.query("SELECT DISTINCT shared_address FROM my_addresses JOIN shared_address_signing_paths USING(address) WHERE wallet=?", [wallet], function(rows) {
			var arrSharedAddresses = rows.map(function(row) {
				return row.shared_address;
			});
			if (arrSharedAddresses.length === 0)
				return handleBalance(assocBalances);
			db.query(
				"SELECT asset, address, is_stable, SUM(amount) AS balance \n\
				FROM outputs CROSS JOIN units USING(unit) \n\
				WHERE is_spent=0 AND sequence='good' AND address IN(?) \n\
				GROUP BY asset, address, is_stable \n\
				UNION ALL \n\
				SELECT NULL AS asset, address, 1 AS is_stable, SUM(amount) AS balance FROM witnessing_outputs \n\
				WHERE is_spent=0 AND address IN(?) GROUP BY address \n\
				UNION ALL \n\
				SELECT NULL AS asset, address, 1 AS is_stable, SUM(amount) AS balance FROM headers_commission_outputs \n\
				WHERE is_spent=0 AND address IN(?) GROUP BY address",
				[arrSharedAddresses, arrSharedAddresses, arrSharedAddresses],
				function(rows) {
					for (var i = 0; i < rows.length; i++) {
						var row = rows[i];
						var asset = row.asset || "base";
						if (!assocBalances[asset])
							assocBalances[asset] = {};
						if (!assocBalances[asset][row.address])
							assocBalances[asset][row.address] = {stable: 0, pending: 0};
						assocBalances[asset][row.address][row.is_stable ? 'stable' : 'pending'] += row.balance;
					}
					handleBalance(assocBalances);
				}
			);
		});
	}

	function initFS(cb) {
		if (bFsInitialized) return cb(null);

		function onFileSystemSuccess(fileSystem) {
			console.log('File system started: ', fileSystem.name, fileSystem.root.name);
			bFsInitialized = true;
			return cb(null);
		}

		function fail(evt) {
			var msg = 'Could not init file system: ' + evt.target.error.code;
			console.log(msg);
			return cb(msg);
		}

		window.requestFileSystem(LocalFileSystem.PERSISTENT, 0, onFileSystemSuccess, fail);
	}

	function readFile(name, cb) {
		initFS(function() {
			window.resolveLocalFileSystemURL(cordova.file.dataDirectory, function(dir) {
				dir.getFile(name, {
					create: false
				}, function(fileEntry) {
					if (!fileEntry) return cb(null, false);
					fileEntry.file(function(file) {
						var reader = new FileReader();
						reader.onloadend = function() {
							var fileBuffer = Buffer.from(new Uint8Array(this.result));
							cb(null, fileBuffer);
						};
						reader.readAsArrayBuffer(file);
					});
				}, function() {
					return cb(null, false);
				});
			}, function() {
			});
		});
	}

	function writeFile(name, data, cb) {
		initFS(function() {
			window.resolveLocalFileSystemURL(cordova.file.dataDirectory, function(dir) {
				dir.getFile(name, {create: true, exclusive: false}, function(fileEntry) {
					if (!fileEntry) return cb(null, false);
					fileEntry.createWriter(function(writer) {
						writer.onwriteend = function() {
							cb(null);
						};
						writer.write(data);
					}, cb);
				}, function() {
					return cb(null, false);
				});
			}, function() {
			});
		});
	}

	function readStorage(cb) {
		readFile('agreeDisclaimer', function(err, agreeDisclaimer) {
			readFile('profile', function(err, profile) {
				readFile('focusedWalletId', function(err, focusedWalletId) {
					readFile('config', function(err, config) {
						cb(agreeDisclaimer, profile, focusedWalletId, JSON.parse(config));
					});
				});
			});
		});
	}

	function setWalletNameAndColor(walletName) {
		var color = root.config.colorFor ? root.config.colorFor[root.focusedClient.credentials.walletId] : '#4A90E2';
		getFromId('name1Color').style.color = color;
		getFromId('name1').innerHTML = walletName;
		getFromId('name2').innerHTML = walletName;
		getFromId('spinnerBg').style.backgroundColor = color;
		getFromId('amountBg').style.backgroundColor = color;
		var subStrName = getFromId('subStrName');
		subStrName.style.backgroundColor = color;
		subStrName.innerHTML = walletName.substr(0, 1);
		document.getElementsByClassName('page')[1].style.display = 'block';
	}

	function setBalancesAndPages(balances) {
		var htmlBalances = '';
		var htmlPages = '';
		var pages = 0;

		function addHtml(key, amount, pages) {
			var firstPage = pages === 0;
			var asset = key;
			if (asset === 'base') asset = 'bytes';
			else if (asset === BLACKBYTES_ASSET) asset = 'blackbytes';
			htmlBalances += '<li id="balance' + pages + '" style="display: ' + ( firstPage ? 'inline-block' : 'none') + ';"><div><strong class="size-36">' + formatAmount(amount, asset) + '</strong></div></li>';
			htmlPages += '<span id="page' + pages + '" ' + (firstPage ? 'class="active"' : '') + '>●</span>';
		}

		for (var key in balances) {
			addHtml(key, balances[key].stable, pages++);
		}
		getFromId('balances').innerHTML = htmlBalances;
		getFromId('pages').innerHTML = htmlPages;
	}

	function setWalletsInMenu() {
		var selectedWalletId = root.focusedClient.credentials.walletId;
		var colors = root.config.colorFor;
		var html = '';

		for (var key in root.walletClients) {
			var credentials = root.walletClients[key].credentials;
			var walletId = credentials.walletId;

			html += '<li onclick="wallet.selectWallet(\'' + walletId + '\')" id="w' + walletId + '" class="nav-item ' + (walletId === selectedWalletId ? 'selected' : '') + '">' +
				'<a class="oh"><div class="avatar-wallet " style="background-color: ' + (colors ? colors[walletId] : '#4A90E2') + '">' + credentials.walletName.substr(0, 1) + ' </div>' +
				'<div class="name-wallet m8t">' + credentials.walletName + '</div></a></li>';
		}

		getFromId('walletList').innerHTML = html;
	}

	function loadFullClient(showClient) {
		self._bByteballCoreLoaded = false; //"fix" : Looks like you are loading multiple copies of byteball core, which is not supported. Running 'npm dedupe' might help.
		var body = document.body;
		var page = document.createElement('div');

		body.appendChild(page);
		var angularJs = document.createElement('script');
		angularJs.src = 'angular.js';
		angularJs.onload = function() {
			var byteballJS = document.createElement('script');
			byteballJS.src = 'byteball.js';
			body.appendChild(byteballJS);
			byteballJS.onload = function() {
				if(showClient) showFullClient();
			}
		};

		body.appendChild(angularJs);
	}

	function showFullClient() {
		getFromId('splash').style.display = 'none';
		swipeListener.close();
		var pages = document.getElementsByClassName('page');
		if (pages.length === 2) {
			document.getElementsByClassName('page')[1].remove();
			document.getElementsByClassName('page')[0].style.display = 'block';
		}
	}

	function initFocusedWallet(cb) {
		setWalletNameAndColor(root.focusedClient.credentials.walletName);
		readBalance(root.focusedClient.credentials.walletId, function(assocBalances) {
			if (!assocBalances[BLACKBYTES_ASSET])
				assocBalances[BLACKBYTES_ASSET] = {is_private: 1, stable: 0, pending: 0};
			readSharedBalance(root.focusedClient.credentials.walletId, function(assocSharedBalances) {
				for (var asset in assocSharedBalances)
					if (!assocBalances[asset])
						assocBalances[asset] = {stable: 0, pending: 0};
				setBalancesAndPages(assocBalances);
				setSlider(assocBalances);
				cb();
			});
		})
	}

	function loadProfile() {
		readStorage(function(agreeDisclaimer, profile, focusedWalletId, config) {
			if (!agreeDisclaimer || !profile) {
				getFromId('splash').style.display = 'block';
				loadFullClient(true);
				return;
			}
			root.config = config;
			decryptOnMobile(profile, function(err, profile) {
				if(err){
					getFromId('splash').style.display = 'block';
					loadFullClient(true);
					return;
				}
				root.profile = createObjProfile(profile);
				root.profile.credentials.forEach(function(credentials) {
					setWalletClients(credentials);
				});
				if (focusedWalletId)
					root.focusedClient = root.walletClients[focusedWalletId];
				else
					root.focusedClient = [];

				if (root.focusedClient.length === 0)
					root.focusedClient = root.walletClients[Object.keys(root.walletClients)[0]];
				initFocusedWallet(function() {
					console.log('LIGHT LOAD END!!!');
					setWalletsInMenu();
					loadFullClient();
				});
			});
		});
	}

	function selectWallet(walletId) {
		var divFocusedClient = getFromId('w' + root.focusedClient.credentials.walletId);
		divFocusedClient.className = divFocusedClient.className.replace('selected').trim();
		getFromId('w' + walletId).className += 'selected';
		root.focusedClient = root.walletClients[walletId];
		writeFile('focusedWalletId', walletId, function() {
		});
		initFocusedWallet();
		openOrCloseMenu();
	}
	
	function formatAmount(bytes, unit) {
		function addSeparators(nStr, thousands, decimal, minDecimals) {
			nStr = nStr.replace('.', decimal);
			var x = nStr.split(decimal);
			var x0 = x[0];
			var x1 = x[1];
			
			x1 = x1.replace(/[0]+$/, '');
			var x2 = x.length > 1 && parseInt(x[1]) ? decimal + x1 : '';

			if (navigator && navigator.vendor && navigator.vendor.indexOf('Apple') >= 0) {
				x0 = x0.replace(/\B(?=(\d{3})+(?!\d))/g, thousands);
				return x0 + x2;
			}
			else {
				return parseFloat(x0 + x2).toLocaleString([], {maximumFractionDigits: 20});
			}
		}

		var Constants = require('../../angular-bitcore-wallet-client/bitcore-wallet-client/lib/common/constants');
		var setting = root.config.wallet.settings;
		var name = unit;
		var unitCode;

		if(unit === 'base'){
			name = setting.unitName;
			unitCode = setting.unitCode;
		}else if(unit === BLACKBYTES_ASSET){
			name = setting.bbUnitName;
			unitCode = setting.bbUnitCode;
		}else {
			unitCode = 'one';
		}
		
		var u = Constants.UNITS[unitCode];
		var intAmountLength = Math.floor(bytes / u.value).toString().length;
		var digits = intAmountLength >= 6 || unit === 'one' ? 0 : 6 - intAmountLength;
		var amount = (bytes / u.value).toFixed(digits);
		
		return addSeparators(amount, ',', '.', u.minDecimals) + ' ' + name;
	}

	root.showFullClient = showFullClient;
	root.loadProfile = loadProfile;
	root.selectWallet = selectWallet;
	return root;
}

window.wallet = new initWallet();

document.addEventListener("deviceready", function() {
	wallet.loadProfile();
});


//slider
function _slider(assocBalances) {
	var self = {};
	self.n = 0;
	self.numberOfSlides = Object.keys(assocBalances).length - 1;

	function setPage(prev, next) {
		getFromId('balance' + prev).style.display = 'none';
		getFromId('balance' + next).style.display = 'block';
		getFromId('page' + prev).className = '';
		getFromId('page' + next).className = 'active';
	}

	self.next = function() {
		if (self.n < self.numberOfSlides) {
			setPage(self.n, ++self.n);
		}
	};

	self.prev = function() {
		if (self.n > 0) {
			setPage(self.n, --self.n);
		}
	};
	return self;
}

function setSlider(assocBalances) {
	window.slider = new _slider(assocBalances);
}

//menu
window.openOrCloseMenu = function() {
	var menuDiv = document.getElementsByClassName('off-canvas-wrap')[1];
	if (menuDiv.className.indexOf('move-right') === -1) {
		menuDiv.className = menuDiv.className.trim() + ' move-right';
	} else {
		menuDiv.className = menuDiv.className.replace('move-right', '').trim();
	}
};

window.menuIsOpen = function() {
	return document.getElementsByClassName('off-canvas-wrap')[1].className.indexOf('move-right') !== -1;
};


//swipe
function _swipeListener() {
	document.addEventListener('touchstart', handleTouchStart, false);
	document.addEventListener('touchmove', handleTouchMove, false);
	
	var root = {};
	var xDown = null;
	var yDown = null;
	var amountBg = false;

	function handleTouchStart(evt) {
		amountBg = false;
		for (var i = 0, l = evt.path.length; i < l; i++) {
			if (evt.path[i].id === 'amountBg') {
				amountBg = true;
				break;
			}
		}
		xDown = evt.touches[0].clientX;
		yDown = evt.touches[0].clientY;
	}

	function handleTouchMove(evt) {
		if (!xDown || !yDown) return;

		var xUp = evt.touches[0].clientX;
		var yUp = evt.touches[0].clientY;

		var xDiff = xDown - xUp;
		var yDiff = yDown - yUp;

		if (Math.abs(xDiff) > Math.abs(yDiff)) {
			if (xDiff > 0) {
				listener('left');
			} else {
				listener('right');
			}
		}

		xDown = null;
		yDown = null;
		
	}
	function listener(direction) {
		if(direction === 'left'){
			if(amountBg){
				slider.next();
			}else if(menuIsOpen()){
				openOrCloseMenu();
			}
		}else if(direction === 'right'){
			if(amountBg){
				slider.prev();
			}else if(!menuIsOpen()){
				openOrCloseMenu();
			}
		}
	}
	root.close = function() {
		document.removeEventListener('touchstart', handleTouchStart, false);
		document.removeEventListener('touchmove', handleTouchMove, false);
	};
	
	return root;
}

var swipeListener = new _swipeListener();

//other
function getFromId(id) {
	return document.getElementById(id);
}