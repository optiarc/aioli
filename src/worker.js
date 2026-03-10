import { expose } from "comlink";
import { simd } from "wasm-feature-detect";

const LOADING_EAGER = "eager";
const LOADING_LAZY = "lazy";

// Hardcode wasm features to avoid downloading a "config.json" for every tool.
// As a result, adding a SIMD package to biowasm requires updating Aioli, but
// there are very few packages that will require that.
const WASM_FEATURES = {
	"ssw": ["simd"],
	"minimap2": ["simd"]
};

// Main Aioli logic
const aioli = {
	// State
	tools: [],   // Tools that are available to use in this WebWorker
	config: {},  // See main.js for defaults
	files: [],   // File/Blob objects that represent local user files we mount to a virtual filesystem
	base: {},    // Base module (e.g. aioli.tools[0]; not always [0], see init())
	fs: {},      // Base module's filesystem (e.g. aioli.tools[0].module.FS)
	opfsRoot: null, // Browser OPFS root handle; used for persistent storage utilities
	directOpfs: null, // Experimental direct OPFS mount state for the legacy Emscripten FS runtime

	// =========================================================================
	// Initialize the WebAssembly module(s)
	// Supports array of tool info, where each tool is represented by:
	// 		{
	// 			tool: "samtools",                             // Required
	// 			version: "1.10",                              // Required
	// 			program: "samtools",                          // Optional, default="tool" name. Only use this for tools with multiple subtools
	// 			urlPrefix: "https://cdn.biowasm.com/v3/...",  // Optional, default=biowasm CDN. Only use for local biowasm development
	// 			loading: "eager",                             // Optional, default="eager". Set to "lazy" to only load modules when they are used in exec()
	// 			reinit: false,                                // Optional, default="false". Set to "true" to reinitialize a module after each invocation
	// 		},
	// =========================================================================
	async init() {
		// Expect at least 1 module
		if(aioli.tools.length === 0)
			throw "Expecting at least 1 tool.";

		// Detect duplicate modules
		const toolsUnique = new Set(aioli.tools.map(t => `${t.tool}/${t.program || t.tool}`));
		if(toolsUnique.size !== aioli.tools.length)
			throw "Found duplicate tools; can only have each tool/program combination at most once.";

		// The base module cannot be reinitializable since we rely on its filesystem
		// to be stable (can remount files explicitly mounted via Aioli, but can't
		// remount files created by a tool). Try to find tool matching this criteria.
		aioli.base = aioli.tools.find(t => t.reinit !== true);
		if(!aioli.base)
			throw "Could not find a tool with `reinit: false` to use as the base module. To fix this issue, include the tool `base/1.0.0` when initializing Aioli.";
		aioli.base.isBaseModule = true;

		// Set up base module first so that its filesystem is ready for the other
		// modules to mount in parallel
		await this._setup(aioli.base);

		// Initialize all other modules
		await this._initModules();
		aioli._log("Ready");
		return true;
	},

	// Initialize all modules that should be eager-loaded (i.e. not lazy-loaded)
	async _initModules() {
		// Initialize WebAssembly modules in parallel (though can't call importScripts in parallel)
		await Promise.all(aioli.tools.map(this._setup));

		// Setup filesystems so that tools can access each other's sample data
		await this._setupFS();
	},

	// =========================================================================
	// Mount files to the virtual file system
	// Supports <FileList>, <File>, <Blob>, strings, and string URLs:
	//		mount(<FileList>)
	//		mount([
	//			<File>,
	// 			{ name: "blob.txt", data: <Blob> },
	//			{ name: "file.txt", data: "string" },
	//			{ name: "hello.txt", url: "https://domain.com/..." },
	//			"https://somefile.com"
	//		])
	// =========================================================================
	mount(files=[]) {
		const dirData = `${aioli.config.dirShared}${aioli.config.dirData}`;
		const dirMounted = `${aioli.config.dirShared}${aioli.config.dirMounted}`;
		let toMountFiles = [], toMountURLs = [], mountedPaths = [];

		// Input validation: auto convert singletons to array for convenience
		if(!Array.isArray(files) && !(files instanceof FileList))
			files = [ files ];
		aioli._log(`Mounting ${files.length} files`);

		// Sort files by type: File vs. Blob vs. URL
		for(let file of files) {
			// Handle Files/Blobs/Data strings
			// String format: { name: "filename.txt", data: "string data" }
			// Blob format: { name: "filename.txt", data: new Blob(['blob data']) }
			if(file instanceof File || (file?.data instanceof Blob && file.name) || (typeof file?.data === "string" && file.name)) {
				if(typeof file?.data === "string")
					file.data = new Blob([ file.data ], { type: "text/plain" });
				toMountFiles.push(file);

			// Handle URLs
			// URL format: { name: "filename.txt", url: "https://url" }
			} else if(file.name && file.url) {
				toMountURLs.push(file);

			// Handle URLs: mount "https://website.com/some/path.js" to "/urls/website.com-some-path.js")
			} else if(typeof file == "string" && file.startsWith("http")) {
				file = { url: file, name: file.split("//").pop().replace(/\//g, "-") };
				toMountURLs.push(file);

			// Otherwise, incorrect data provided
			} else {
				throw `Cannot mount file(s) specified. Must be a File, Blob, a URL string, or { name: "file.txt", data: "string" }.`;
			}

			mountedPaths.push(file.name);
		}

		// Unmount and remount files since WORKERFS is read-only (i.e. can only mount a folder once)
		try {
			aioli.fs.unmount(dirMounted);
		} catch(e) {}

		// Lazy-mount URLs, i.e. don't download any of them, but will automatically do
		// HTTP Range requests when a tool requests a subset of bytes from a file.
		for(let file of toMountURLs)
			aioli.fs.createLazyFile(dirData, file.name, file.url, true, true);

		// Mount files (save for later for the next time we need to remount them)
		aioli.files = aioli.files.concat(toMountFiles);
		aioli.base.module.FS.mount(aioli.base.module.WORKERFS, {
			files: aioli.files.filter(f => f instanceof File),
			blobs: aioli.files.filter(f => f?.data instanceof Blob)
		}, dirMounted);

		// Create symlinks for convenience. The folder "dirMounted" is a WORKERFS, which is read-only. By adding
		// symlinks to a separate writeable folder "dirData", we can support commands like "samtools index abc.bam",
		// which create a "abc.bam.bai" file in the same path where the .bam file is created.
		toMountFiles.map(file => {
			const oldpath = `${dirMounted}/${file.name}`;
			const newpath = `${dirData}/${file.name}`;
			try {
				aioli.fs.unlink(newpath);
			} catch(e) {}
			aioli._log(`Creating symlink: ${newpath} --> ${oldpath}`)

			// Create symlink within first module's filesystem (note: tools[0] is always the "base" biowasm module)
			aioli.fs.symlink(oldpath, newpath);
		});

		return mountedPaths.map(path => `${dirData}/${path}`);
	},

	// =========================================================================
	// Execute a command
	// =========================================================================
	async exec(command, args=null, options={}) {
		// Input validation
		aioli._log(`Executing %c${command}%c args=${args}`, "color:darkblue; font-weight:bold", "");
		if(!command)
			throw "Expecting a command";
		// Extract tool name and arguments
		let toolName = command;
		if(args == null) {
			args = command.trim().split(/ +/); // trim and split by one or more whitespaces to avoid common errors due to extra spaces.
			toolName = args.shift();
		}
		args = args.map(arg => aioli._resolveFsPath(arg));

		// Does it match a program we've already initialized?
		const tool = aioli.tools.find(t => {
			let tmpToolName = toolName;
			// Take special WebAssembly features into account
			if(t?.features?.simd === true)
				tmpToolName = `${tmpToolName}-simd`;
			return t.program == tmpToolName;
		});
		if(tool == null)
			throw `Program ${toolName} not found.`;
		// Prepare tool
		tool.stdout = "";
		tool.stderr = "";

		// If this is a lazy-loaded module, load it now by setting it to eager loading.
		// Note that calling _initModules will only load modules that haven't yet been loaded.
		if(tool.loading == LOADING_LAZY) {
			tool.loading = LOADING_EAGER;
			await this._initModules();
		}

		if(aioli.config.opfsBackend === "direct")
			await aioli._prepareDirectOpfsArgs(toolName, args);

		if(options.sync != null)
			await aioli._syncPathsFromOpfs(options.sync);

		// Run command. Stdout/Stderr will be saved to "tool.stdout"/"tool.stderr" (see "print" and "printErr" above)
		try {
			tool.module.callMain(args);
		} catch (error) {
			console.error(error);
		}

		// Flush stdout/stderr to make sure we got everything. Otherwise, if use a command like 
		// `bcftools query -f "%ALT" variants.bcf`, it won't output anything until the next
		// invocation of that command!
		try {
			tool.module.FS.close( tool.module.FS.streams[1] );
			tool.module.FS.close( tool.module.FS.streams[2] );
		} catch (error) {}
		// Re-open stdout/stderr (fix error "error closing standard output: -1")
		tool.module.FS.streams[1] = tool.module.FS.open("/dev/stdout", "w");
		tool.module.FS.streams[2] = tool.module.FS.open("/dev/stderr", "w");

		// Return output, either stdout/stderr interleaved, or each one separately
		let result = { stdout: tool.stdout, stderr: tool.stderr };
		if(aioli.config.printInterleaved)
			result = tool.stdout;

		if(options.persist != null)
			await aioli._persistOutputs(options.persist);
		if(options.sync != null)
			await aioli._syncPathsToOpfs(options.sync);

		// Reinitialize module after done? This is useful for tools that don't properly reset their global state the
		// second time the `main()` function is called.
		if(tool.reinit === true) {
			await this.reinit(tool.tool);
		}

		return result;
	},

	// =========================================================================
	// Utility functions for common file operations
	// =========================================================================
	cat(path) {
		return aioli._fileop("cat", path);
	},

	ls(path) {
		return aioli._fileop("ls", path);
	},

	download(path) {
		return aioli._fileop("download", path);
	},

	downloadBlob(path) { // return a blob instead of a URL, so it can be downloaded with other files by jszip
		return aioli._fileop("downloadBlob", path);
	},

	pwd() {
		return aioli._publicFsPath(aioli.fs.cwd());
	},

	cd(path) {
		path = aioli._resolveFsPath(path);
		for(let tool of aioli.tools) {
			// Ignore modules that haven't been initialized yet (i.e. lazy-loaded modules)
			const module = tool.module;
			if(!module)
				continue;
			tool.module.FS.chdir(path);
		}
	},

	async mkdir(path) {
		if(aioli.config.opfsBackend === "direct" && typeof path === "string" && (path === aioli.config.dirOpfs || path.startsWith(`${aioli.config.dirOpfs}/`))) {
			await aioli._directEnsureDir(path);
			return true;
		}
		path = aioli._resolveFsPath(path);
		aioli.fs.mkdir(path);
		return true;
	},

	read({ path, length, flag="r", offset=0, position=0 }) {
		path = aioli._resolveFsPath(path);
		const stream = aioli.fs.open(path, flag);
		const buffer = new Uint8Array(length);
		aioli.fs.read(stream, buffer, offset, length, position);
		aioli.fs.close(stream);
		return buffer;
	},

	write({ path, buffer, flag="w+", offset=0, position=0 }) {
		path = aioli._resolveFsPath(path);
		const stream = aioli.fs.open(path, flag);
		aioli.fs.write(stream, buffer, offset, buffer.length, position);
		aioli.fs.close(stream);
	},

	// =========================================================================
	// Reinitialize a tool
	// =========================================================================
	async reinit(toolName) {
		const tool = aioli.tools.find(t => t.tool == toolName);
		// Save state before reinitializing
		const pwd = aioli.base.module.FS.cwd();

		// Reinitialize module
		Object.assign(tool, tool.config);
		tool.ready = false;
		await this.init();
		// If reinitialized the base module, remount previously mounted files
		if(tool.isBaseModule)
			this.mount();

		// Go back to previous folder
		this.cd(pwd);
	},

	// =========================================================================
	// Close the worker
	// =========================================================================
	async close() {
		aioli._log("Closing worker...");
		self.close();
	},

	opfsSupport(toolName = null) {
		if(aioli._supportsLegacyDirectOpfs()) {
			return {
				backend: aioli.config.opfsBackend,
				available: true,
				reason: null,
				source: "aioli-legacyfs"
			};
		}

		const tool = toolName == null
			? aioli.base
			: aioli.tools.find(t => t.tool === toolName || t.program === toolName);
		if(!tool?.module) {
			return {
				backend: aioli.config.opfsBackend,
				available: false,
				reason: "Tool module is not initialized.",
				source: "uninitialized"
			};
		}

		const mountOpfs = tool.module.mountOpfs;
		const capabilities = tool.module.biowasmCapabilities || {};

		if(typeof capabilities.mountOpfs === "boolean") {
			return {
				backend: aioli.config.opfsBackend,
				available: capabilities.mountOpfs,
				reason: capabilities.mountOpfs ? null : "Module capability metadata reports no direct mountOpfs() support.",
				source: capabilities.mountOpfsSource || "metadata"
			};
		}

		if(typeof mountOpfs !== "function") {
			return {
				backend: aioli.config.opfsBackend,
				available: false,
				reason: "Module does not expose mountOpfs().",
				source: "missing"
			};
		}

		if(mountOpfs.__biowasmStub === true) {
			return {
				backend: aioli.config.opfsBackend,
				available: false,
				reason: "Module exposes only the generated mountOpfs() stub.",
				source: "stub"
			};
		}

		return {
			backend: aioli.config.opfsBackend,
			available: true,
			reason: null,
			source: "function"
		};
	},

	_requireDirectOpfsSupport(module, toolName = null) {
		const support = aioli.opfsSupport(toolName);
		if(support.available)
			return true;
		const detail = support.reason ? ` ${support.reason}` : "";
		throw new Error(`The 'direct' OPFS backend requires module/runtime OPFS mount support.${detail}`);
	},

	// =========================================================================
	// OPFS utilities
	// =========================================================================
	async opfsMkdir(path) {
		await aioli._opfsLookup(path, { create: true, directory: true });
		return true;
	},

	async opfsWrite(path, data = "") {
		if(aioli.config.opfsBackend === "direct" && aioli._supportsLegacyDirectOpfs()) {
			const fsPath = aioli._resolveFsPath(`${aioli.config.dirOpfs}${path}`);
			await aioli._directPrepareFile(fsPath, { create: true, truncate: true });
			const entry = aioli._directEntryForFsPath(fsPath);
			const buffer = data instanceof Uint8Array
				? data
				: data instanceof ArrayBuffer
					? new Uint8Array(data)
					: new TextEncoder().encode(String(data));
			entry.accessHandle.truncate(0);
			if(buffer.byteLength > 0)
				entry.accessHandle.write(buffer, { at: 0 });
			entry.accessHandle.flush();
			entry.size = buffer.byteLength;
			entry.timestamp = Date.now();
			if(entry.node)
				entry.node.timestamp = entry.timestamp;
			return true;
		}
		const handle = await aioli._opfsLookup(path, { create: true });
		const writable = await handle.createWritable();
		try {
			await writable.write(data);
		} finally {
			await writable.close();
		}
		return true;
	},

	async opfsRead(path, options = {}) {
		const format = options.encoding || options.format || "text";
		if(aioli.config.opfsBackend === "direct" && aioli._supportsLegacyDirectOpfs()) {
			const fsPath = aioli._resolveFsPath(`${aioli.config.dirOpfs}${path}`);
			const info = aioli.fs?.analyzePath?.(fsPath);
			if(info?.exists && info.object?.opfsEntry?.accessHandle) {
				const entry = info.object.opfsEntry;
				const length = entry.size ?? entry.accessHandle.getSize();
				const bytes = new Uint8Array(length);
				if(length > 0)
					entry.accessHandle.read(bytes, { at: 0 });
				if(format === "arrayBuffer")
					return bytes.buffer.slice(0);
				if(format === "blob")
					return new Blob([bytes]);
				return new TextDecoder().decode(bytes);
			}
		}
		const handle = await aioli._opfsLookup(path);
		const file = await handle.getFile();
		if(format === "arrayBuffer")
			return await file.arrayBuffer();
		if(format === "blob")
			return file;
		return await file.text();
	},

	async opfsList(path = "/") {
		const dir = await aioli._opfsLookup(path, { directory: true });
		const entries = [];
		for await (const [name, handle] of dir.entries()) {
			entries.push({
				name,
				kind: handle.kind
			});
		}
		entries.sort((a, b) => a.name.localeCompare(b.name));
		return entries;
	},

	async opfsDelete(path, options = {}) {
		if(aioli.config.opfsBackend === "direct" && aioli._supportsLegacyDirectOpfs())
			aioli._directForgetPath(aioli._resolveFsPath(`${aioli.config.dirOpfs}${path}`), { recursive: options.recursive === true });
		const parts = aioli._splitOpfsPath(path);
		if(parts.length === 0)
			throw "Cannot delete the OPFS root.";

		const name = parts.pop();
		const parent = await aioli._opfsLookup(parts.join("/"), { directory: true });
		await parent.removeEntry(name, { recursive: options.recursive === true });
		return true;
	},

	async opfsStage(opfsPath, fsPath = null) {
		const targetPath = aioli._resolveFsPath(fsPath || `${aioli.config.dirOpfs}${opfsPath}`);
		await aioli._opfsBackendStageFromOpfs(opfsPath, targetPath);
		return aioli._publicFsPath(targetPath);
	},

	async opfsFlush(fsPath, opfsPath = null) {
		fsPath = aioli._resolveFsPath(fsPath);
		const targetPath = opfsPath || aioli._defaultOpfsPath(fsPath);
		await aioli._opfsBackendFlushToOpfs(fsPath, targetPath);
		return targetPath;
	},

	async copyToOpfs(fsPath, opfsPath = null) {
		fsPath = aioli._resolveFsPath(fsPath);
		if(aioli.config.opfsBackend === "direct" && fsPath.startsWith(`${aioli.config.dirOpfs}/`))
			return opfsPath || aioli._defaultOpfsPath(fsPath);
		if(!opfsPath)
			opfsPath = `/${fsPath.split("/").pop()}`;
		const data = aioli.fs.readFile(fsPath);
		await aioli.opfsWrite(opfsPath, data);
		return opfsPath;
	},

	async copyFromOpfs(opfsPath, fsPath = null) {
		if(!fsPath)
			fsPath = `${aioli.config.dirOpfs}${opfsPath}`;
		fsPath = aioli._resolveFsPath(fsPath);
		if(aioli.config.opfsBackend === "direct" && fsPath.startsWith(`${aioli.config.dirOpfs}/`)) {
			await aioli._directPrepareFile(fsPath, { create: false, truncate: false });
			return fsPath;
		}
		const data = new Uint8Array(await aioli.opfsRead(opfsPath, { format: "arrayBuffer" }));
		const dir = fsPath.split("/").slice(0, -1).join("/");
		if(dir)
			aioli.fs.mkdirTree(dir);
		aioli.fs.writeFile(fsPath, data);
		return fsPath;
	},

	// =========================================================================
	// Stdin management: Use `CLI.stdin = "some text"` to set stdin before calling a tool
	// =========================================================================
	_stdinTxt: "",
	_stdinPtr: 0,
	get stdin() {
		return aioli._stdinTxt;
	},
	set stdin(txt = "") {
		aioli._log(`Setting stdin to %c${txt}%c`, "color:darkblue", "");
		aioli._stdinTxt = txt;
		aioli._stdinPtr = 0;
	},

	// =========================================================================
	// Initialize a tool
	// =========================================================================
	async _setup(tool) {
		if(tool.ready)
			return;
		aioli._log(`Setting up ${tool.tool} (base = ${tool.isBaseModule === true})...`);

		// Save original config in case need them to reinitialize (use Object.assign to avoid ref changes)
		tool.config = Object.assign({}, tool);

		// -----------------------------------------------------------------
		// Set default settings
		// -----------------------------------------------------------------

		// By default, use the CDN path, but also accept custom paths for each tool
		if(!tool.urlPrefix)
			tool.urlPrefix = `${aioli.config.urlCDN}/${tool.tool}/${tool.version}`;

		// In most cases, the program is the same as the tool name, but there are exceptions. For example, for the
		// tool "seq-align", program can be "needleman_wunsch", "smith_waterman", or "lcs".
		if(!tool.program)
			tool.program = tool.tool;

		// SIMD isn't enabled on all browsers. Load the right .wasm file based on the user's browser
		if(!tool.features) {
			tool.features = {};
			const wasmFeatures = WASM_FEATURES[tool.program] || [];
			if(wasmFeatures.includes("simd")) {
				if(await simd()) {
					tool.program += "-simd";
					tool.features.simd = true;
				} else {
					aioli._log(`WebAssembly SIMD is not supported in this browser; will load non-SIMD version of ${tool.program}.`);
				}
			}
		}

		// First module can't be lazy-loaded because that's where the main filesystem is mounted
		if(tool.isBaseModule)
			tool.loading = LOADING_EAGER;
		// If want lazy loading, don't go any further
		if(tool.loading === LOADING_LAZY) {
			aioli._log(`Will lazy-load ${tool.tool}; skipping initialization.`)
			return;
		}

		// -----------------------------------------------------------------
		// Import the WebAssembly module
		// -----------------------------------------------------------------

		// All biowasm modules export the variable "Module" so assign it
		self.importScripts(`${tool.urlPrefix}/${tool.program}.js`);

		// Initialize the Emscripten module and pass along settings to overwrite
		tool.module = await Module({
			// By default, tool name is hardcoded as "./this.program"
			thisProgram: tool.program,
			// Used by Emscripten to find path to .wasm / .data files
			locateFile: (path, prefix) => `${tool.urlPrefix}/${path}`,
			// Custom stdin handling
			stdin: () => {
				if(aioli._stdinPtr < aioli.stdin.length)
					return aioli.stdin.charCodeAt(aioli._stdinPtr++);
				else {
					aioli.stdin = "";
					return null;
				}
			},
			// Setup print functions to store stdout/stderr output
			print: text => {
				if(aioli.config.printStream) {
					postMessage({
						type: "biowasm",
						value: {
							stdout: text,
						},
					});
				} else {
					tool.stdout += text + "\n";
				}
			},
			printErr: text => {
				const destination = aioli.config.printInterleaved ? "stdout" : "stderr";
				if(aioli.config.printStream) {
					postMessage({
						type: "biowasm",
						value: {
							[destination]: text,
						},
					});
				} else {
					tool[destination] += text + "\n";
				}
			}
		});

		// -----------------------------------------------------------------
		// Setup file system
		// -----------------------------------------------------------------

		const FS = tool.module.FS;

		// The base module has the main filesystem, which other tools will mount
		if(tool.isBaseModule) {
			aioli._log(`Setting up ${tool.tool} with base module filesystem...`);
			FS.mkdir(aioli.config.dirShared, 0o777);
			FS.mkdir(`${aioli.config.dirShared}/${aioli.config.dirData}`, 0o777);
			FS.mkdir(`${aioli.config.dirShared}/${aioli.config.dirMounted}`, 0o777);
			await aioli._opfsBackendInitFS(FS, tool.module);
			FS.chdir(`${aioli.config.dirShared}/${aioli.config.dirData}`);
			aioli.fs = FS;

		// Non-base modules should proxy base module's FS
		} else {
			aioli._log(`Setting up ${tool.tool} with filesystem...`)
			// PROXYFS allows us to point "/shared" to the base module's filesystem "/shared"
			FS.mkdir(aioli.config.dirShared);
			FS.mount(tool.module.PROXYFS, {
				root: aioli.config.dirShared,
				fs: aioli.fs
			}, aioli.config.dirShared);

			// Set the working directory to be the same as the base module so we keep them in sync.
			// If all modules are eager loaded, this will just be /shared/data, but if this module
			// is lazy loaded, it should be whichever folder the base module is currently at!
			FS.chdir(aioli.fs.cwd());
		}

		// -----------------------------------------------------------------
		// Initialize variables
		// -----------------------------------------------------------------

		tool.stdout = "";
		tool.stderr = "";
		tool.ready = true;
	},

	// Some tools have preloaded files mounted to their filesystems to hold sample data (e.g. /samtools/examples/).
	// By default, those are only accessible from the filesystem of the respective tool. Here, we want to allow
	// other modules to also have access to those sample data files.
	async _setupFS() {
		// Mount every tool's sample data onto the base module (including base module's own sample data)
		const fsDst = aioli.fs;
		for(let tool of aioli.tools) {
			// Ignore lazy-loaded modules that haven't been initialized yet
			if(!tool.ready)
				continue;

			// Skip if the source path doesn't exist or if the destination path has already been created
			const fsSrc = tool.module.FS;
			const pathSrc = `/${tool.tool}`;
			const pathDst = `${aioli.config.dirShared}${pathSrc}`;
			if(!fsSrc.analyzePath(pathSrc).exists || fsDst.analyzePath(pathDst).exists)
				continue;

			aioli._log(`Mounting ${pathSrc} onto ${aioli.base.tool} filesystem at ${pathDst}`);
			fsDst.mkdir(pathDst);
			fsDst.mount(aioli.base.module.PROXYFS, {
				root: pathSrc,
				fs: fsSrc
			}, pathDst);
		}
	},

	// =========================================================================
	// Utilities
	// =========================================================================
	async _opfsRootHandle() {
		if(aioli.opfsRoot)
			return aioli.opfsRoot;
		if(!navigator?.storage?.getDirectory)
			throw "OPFS is not available in this environment.";
		aioli.opfsRoot = await navigator.storage.getDirectory();
		return aioli.opfsRoot;
	},

	_splitOpfsPath(path = "/") {
		if(typeof path !== "string")
			throw "OPFS path must be a string.";
		return path.split("/").filter(Boolean);
	},

	async _opfsLookup(path = "/", options = {}) {
		const parts = aioli._splitOpfsPath(path);
		const wantDirectory = options.directory === true;
		let dir = await aioli._opfsRootHandle();

		if(parts.length === 0) {
			if(wantDirectory)
				return dir;
			throw "OPFS root is a directory.";
		}

		for(let i = 0; i < parts.length - 1; i++)
			dir = await dir.getDirectoryHandle(parts[i], { create: options.create === true });

		const leaf = parts.at(-1);
		if(wantDirectory)
			return await dir.getDirectoryHandle(leaf, { create: options.create === true });
		return await dir.getFileHandle(leaf, { create: options.create === true });
	},

	async _persistOutputs(persist) {
		if(!Array.isArray(persist))
			persist = [persist];

		for(let item of persist) {
			if(typeof item === "string")
				item = { from: item };
			if(!item?.from)
				throw "Persist entries must define a source path.";

			const to = item.to || `/${item.from.split("/").pop()}`;
			await aioli.copyToOpfs(item.from, to);
		}
	},

	_defaultOpfsPath(fsPath) {
		if(fsPath.startsWith(`${aioli._opfsBackendRoot()}/`))
			return fsPath.slice(aioli._opfsBackendRoot().length);
		if(fsPath.startsWith(`${aioli.config.dirOpfs}/`))
			return fsPath.slice(aioli.config.dirOpfs.length);
		if(fsPath === aioli._opfsBackendRoot() || fsPath === aioli.config.dirOpfs)
			return "/";
		return `/${fsPath.split("/").filter(Boolean).pop()}`;
	},

	async _syncPathsFromOpfs(sync) {
		if(!Array.isArray(sync))
			sync = [sync];

		for(let item of sync) {
			if(typeof item === "string")
				item = { path: item };

			const opfsPath = item.opfs || item.path;
			const fsPath = aioli._resolveFsPath(item.fs || `${aioli.config.dirOpfs}${opfsPath}`);
			try {
				await aioli.opfsStage(opfsPath, fsPath);
			} catch(error) {
				// Output paths often do not exist in OPFS yet on the way into a command.
				if(error?.name !== "NotFoundError" || item.skipMissing === false)
					throw error;
			}
		}
	},

	async _syncPathsToOpfs(sync) {
		if(!Array.isArray(sync))
			sync = [sync];

		for(let item of sync) {
			if(typeof item === "string")
				item = { path: item };

			const opfsPath = item.opfs || item.path;
			const fsPath = aioli._resolveFsPath(item.fs || `${aioli.config.dirOpfs}${opfsPath}`);
			const info = aioli.fs.analyzePath(fsPath);
			if(!info.exists)
				continue;
			await aioli.opfsFlush(fsPath, opfsPath);
		}
	},

	// Common file operations
	_fileop(operation, path) {
		path = aioli._resolveFsPath(path);
		aioli._log(`Running ${operation} ${path}`);

		// Check whether the file exists
		const info = aioli.fs.analyzePath(path);
		if(!info.exists) {
			aioli._log(`File ${path} not found.`);
			return false;
		}

		// Execute operation of interest
		switch (operation) {
			case "cat":
				return aioli.fs.readFile(path, { encoding: "utf8" });

			case "ls":
				if(aioli.fs.isFile(info.object.mode))
					return aioli.fs.stat(path);
				return aioli.fs.readdir(path);

			case "download":
				const blob = new Blob([ this.cat(path) ]);
				return URL.createObjectURL(blob);

			case "downloadBlob":
				const file = aioli.fs.readFile(path);
				return new Blob([ file ]); // return a blob instead of a URL, so it can be downloaded with other files by jszip
		}

		return false;
	},

	_resolveFsPath(path) {
		if(typeof path !== "string")
			return path;
		if(path === aioli.config.dirOpfs)
			return aioli._opfsBackendRoot();
		if(path.startsWith(`${aioli.config.dirOpfs}/`))
			return `${aioli._opfsBackendRoot()}${path.slice(aioli.config.dirOpfs.length)}`;
		return path;
	},

	_publicFsPath(path) {
		if(typeof path !== "string")
			return path;
		if(path === aioli._opfsBackendRoot())
			return aioli.config.dirOpfs;
		if(path.startsWith(`${aioli._opfsBackendRoot()}/`))
			return `${aioli.config.dirOpfs}${path.slice(aioli._opfsBackendRoot().length)}`;
		return path;
	},

	_opfsBackendRoot() {
		return aioli._opfsBackend().root;
	},

	_opfsBackendInitFS(FS, module) {
		return aioli._opfsBackend().initFS(FS, module);
	},

	async _opfsBackendStageFromOpfs(opfsPath, fsPath) {
		return await aioli._opfsBackend().stageFromOpfs(opfsPath, fsPath);
	},

	async _opfsBackendFlushToOpfs(fsPath, opfsPath) {
		return await aioli._opfsBackend().flushToOpfs(fsPath, opfsPath);
	},

	// OPFS backend contract:
	// - root: filesystem path exposed inside the wasm runtime for the backend implementation
	// - initFS(FS, module): prepare the backend root inside the module filesystem during startup
	// - stageFromOpfs(opfsPath, fsPath): make browser OPFS content available at fsPath before a command
	// - flushToOpfs(fsPath, opfsPath): persist content from fsPath back to browser OPFS after a command
	//
	// The staged backend implements this by copying through JS memory. A future direct backend
	// should satisfy the same contract while mounting OPFS directly through module/runtime support
	// and avoiding those copies.
	_opfsBackend() {
		switch (aioli.config.opfsBackend) {
			case "staged":
				return {
					root: aioli.config.dirOpfsStage,
					initFS(FS) {
						FS.mkdirTree(aioli.config.dirOpfsStage);
					},
					async stageFromOpfs(opfsPath, fsPath) {
						await aioli.copyFromOpfs(opfsPath, fsPath);
					},
					async flushToOpfs(fsPath, opfsPath) {
						await aioli.copyToOpfs(fsPath, opfsPath);
					},
				};
			case "direct":
				return {
					root: aioli.config.dirOpfs,
					async initFS(FS, module) {
						aioli._requireDirectOpfsSupport(module);
						await aioli._directMount(FS);
					},
					async stageFromOpfs(opfsPath, fsPath) {
						await aioli._directPrepareFile(fsPath, { create: false, truncate: false });
						return fsPath;
					},
					async flushToOpfs(fsPath, opfsPath) {
						await aioli._directPrepareFile(fsPath, {
							create: false,
							truncate: false,
							opfsPath
						});
						return opfsPath;
					},
				};
			default:
				throw `Unsupported OPFS backend '${aioli.config.opfsBackend}'.`;
		}
	},

	_supportsLegacyDirectOpfs() {
		return aioli.config.opfsBackend === "direct"
			&& typeof navigator?.storage?.getDirectory === "function"
			&& typeof FileSystemFileHandle !== "undefined"
			&& typeof FileSystemFileHandle.prototype?.createSyncAccessHandle === "function";
	},

	async _prepareDirectOpfsArgs(toolName, args = []) {
		if(!aioli._supportsLegacyDirectOpfs())
			return;

		const outputFlags = new Set(["-o", "--output"]);
		for(let i = 0; i < args.length; i++) {
			const arg = args[i];
			if(typeof arg !== "string" || !arg.startsWith(`${aioli.config.dirOpfs}/`))
				continue;

			const isOutput = i > 0 && outputFlags.has(args[i - 1]);
			if(isOutput) {
				await aioli._directPrepareFile(arg, { create: true, truncate: true });
				continue;
			}

			try {
				await aioli._directPrepareFile(arg, { create: false, truncate: false });
			} catch (error) {
				if(error?.name !== "NotFoundError")
					throw error;
			}
		}

		await aioli._prepareImplicitDirectOpfsOutputs(toolName, args);
	},

	async _prepareImplicitDirectOpfsOutputs(toolName, args = []) {
		if(toolName !== "samtools")
			return;

		const subcommand = args[0];
		if(subcommand === "index") {
			const inputPath = args.find(arg => typeof arg === "string" && arg.startsWith(`${aioli.config.dirOpfs}/`) && !arg.startsWith("-"));
			if(!inputPath)
				return;
			await aioli._directPrepareFile(`${inputPath}.bai`, { create: true, truncate: true });
			return;
		}

		if(subcommand === "faidx") {
			const inputPath = args.find(arg => typeof arg === "string" && arg.startsWith(`${aioli.config.dirOpfs}/`) && !arg.startsWith("-"));
			if(!inputPath)
				return;
			await aioli._directPrepareFile(`${inputPath}.fai`, { create: true, truncate: true });
		}
	},

	_directState(FS = aioli.fs) {
		if(!aioli.directOpfs)
			aioli.directOpfs = { FS, mounted: false, entries: new Map(), fsType: null };
		if(FS && !aioli.directOpfs.FS)
			aioli.directOpfs.FS = FS;
		return aioli.directOpfs;
	},

	_directNormalizeFsPath(fsPath) {
		if(fsPath === aioli.config.dirOpfs)
			return aioli.config.dirOpfs;
		return fsPath.replace(/\/+$/g, "");
	},

	_directToOpfsPath(fsPath) {
		fsPath = aioli._directNormalizeFsPath(aioli._resolveFsPath(fsPath));
		if(fsPath === aioli.config.dirOpfs)
			return "/";
		return fsPath.slice(aioli.config.dirOpfs.length) || "/";
	},

	_directErrno(code) {
		const ERRNO_CODES = {
			EEXIST: 20,
			EINVAL: 28,
			EISDIR: 31,
			ENOENT: 44,
			ENOSYS: 52,
			ENOTDIR: 54,
			ENOTEMPTY: 55,
			EXDEV: 75,
		};
		const ErrnoError = aioli._directState().FS.ErrnoError;
		return new ErrnoError(ERRNO_CODES[code] || ERRNO_CODES.EINVAL);
	},

	async _directMount(FS) {
		const state = aioli._directState(FS);
		if(state.mounted)
			return;

		const createNode = (parent, name, mode, dev = 0, mount = parent?.mount || null, opfsPath = "/") => {
			const node = FS.createNode(parent, name, mode, dev);
			node.mount = mount;
			node.timestamp = Date.now();
			node.opfsPath = opfsPath;
			if(FS.isDir(mode)) {
				node.contents = {};
				node.node_ops = nodeOps.dir;
				node.stream_ops = streamOps.dir;
			} else if(FS.isFile(mode)) {
				node.node_ops = nodeOps.file;
				node.stream_ops = streamOps.file;
			}
			if(parent) {
				parent.contents[name] = node;
				parent.timestamp = node.timestamp;
			}
			return node;
		};

		const statForNode = node => {
			const size = FS.isDir(node.mode)
				? 4096
				: node.opfsEntry?.size ?? 0;
			return {
				dev: 1,
				ino: node.id,
				mode: node.mode,
				nlink: 1,
				uid: 0,
				gid: 0,
				rdev: node.rdev,
				size,
				atime: new Date(node.timestamp),
				mtime: new Date(node.timestamp),
				ctime: new Date(node.timestamp),
				blksize: 4096,
				blocks: Math.max(1, Math.ceil(size / 4096))
			};
		};

		const lookupPath = (parent, name) => {
			if(!FS.isDir(parent.mode))
				throw aioli._directErrno("ENOTDIR");
			const child = parent.contents[name];
			if(!child)
				throw aioli._directErrno("ENOENT");
			return child;
		};

		const streamOps = {
			dir: {
				llseek() {
					throw aioli._directErrno("EINVAL");
				},
			},
			file: {
				open(stream) {
					const entry = stream.node.opfsEntry;
					if(!entry?.accessHandle)
						throw aioli._directErrno("ENOSYS");
					stream.position = 0;
				},
				close(stream) {
					const entry = stream.node.opfsEntry;
					if(entry?.accessHandle)
						entry.accessHandle.flush();
				},
				read(stream, buffer, offset, length, position) {
					const entry = stream.node.opfsEntry;
					if(!entry?.accessHandle)
						throw aioli._directErrno("ENOENT");
					const target = buffer.subarray(offset, offset + length);
					const at = position ?? stream.position ?? 0;
					const bytesRead = entry.accessHandle.read(target, { at }) || 0;
					if(position == null)
						stream.position = at + bytesRead;
					return bytesRead;
				},
				write(stream, buffer, offset, length, position) {
					const entry = stream.node.opfsEntry;
					if(!entry?.accessHandle)
						throw aioli._directErrno("ENOENT");
					const source = buffer.subarray(offset, offset + length);
					const at = position ?? stream.position ?? 0;
					const bytesWritten = entry.accessHandle.write(source, { at }) || 0;
					entry.accessHandle.flush();
					entry.size = Math.max(entry.size || 0, at + bytesWritten);
					entry.timestamp = Date.now();
					stream.node.timestamp = entry.timestamp;
					if(position == null)
						stream.position = at + bytesWritten;
					return bytesWritten;
				},
				llseek(stream, offset, whence) {
					const entry = stream.node.opfsEntry;
					const size = entry?.size ?? 0;
					let position = offset;
					if(whence === 1)
						position += stream.position;
					else if(whence === 2)
						position += size;
					if(position < 0)
						throw aioli._directErrno("EINVAL");
					stream.position = position;
					return position;
				},
				allocate(stream, offset, length) {
					const entry = stream.node.opfsEntry;
					if(!entry?.accessHandle)
						throw aioli._directErrno("ENOENT");
					const size = offset + length;
					entry.accessHandle.truncate(size);
					entry.size = size;
					entry.timestamp = Date.now();
					stream.node.timestamp = entry.timestamp;
				},
			},
		};

		const nodeOps = {
			dir: {
				getattr: statForNode,
				setattr(node, attr) {
					if(attr.mode != null)
						node.mode = attr.mode;
					if(attr.timestamp != null)
						node.timestamp = attr.timestamp;
				},
				lookup: lookupPath,
				mknod(parent, name, mode, dev) {
					const opfsPath = parent.opfsPath === "/" ? `/${name}` : `${parent.opfsPath}/${name}`;
					const node = createNode(parent, name, mode, dev, parent.mount, opfsPath);
					const entry = state.entries.get(opfsPath);
					if(entry) {
						node.opfsEntry = entry;
						entry.node = node;
					}
					return node;
				},
				mkdir(parent, name, mode) {
					return this.mknod(parent, name, mode, 0);
				},
				readdir(node) {
					return [".", "..", ...Object.keys(node.contents).sort()];
				},
				unlink(parent, name) {
					const node = lookupPath(parent, name);
					if(FS.isDir(node.mode))
						throw aioli._directErrno("EISDIR");
					delete parent.contents[name];
					aioli._directForgetPath(aioli._resolveFsPath(`${aioli.config.dirOpfs}${node.opfsPath}`));
				},
				rmdir(parent, name) {
					const node = lookupPath(parent, name);
					if(Object.keys(node.contents).length > 0)
						throw aioli._directErrno("ENOTEMPTY");
					delete parent.contents[name];
				},
				rename(oldNode, newDir, newName) {
					if(oldNode.parent !== newDir)
						throw aioli._directErrno("EXDEV");
					delete oldNode.parent.contents[oldNode.name];
					oldNode.name = newName;
					newDir.contents[newName] = oldNode;
				},
				symlink() {
					throw aioli._directErrno("ENOSYS");
				},
			},
			file: {
				getattr: statForNode,
				setattr(node, attr) {
					const entry = node.opfsEntry;
					if(attr.mode != null)
						node.mode = attr.mode;
					if(attr.timestamp != null)
						node.timestamp = attr.timestamp;
					if(attr.size != null && entry?.accessHandle) {
						entry.accessHandle.truncate(attr.size);
						entry.accessHandle.flush();
						entry.size = attr.size;
						entry.timestamp = Date.now();
						node.timestamp = entry.timestamp;
					}
				},
			},
		};

		state.fsType = {
			mount: mount => createNode(null, "/", 16895, 0, mount, "/"),
			createNode,
		};

		if(!FS.analyzePath(aioli.config.dirOpfs).exists)
			FS.mkdir(aioli.config.dirOpfs);
		FS.mount(state.fsType, {}, aioli.config.dirOpfs);
		state.mounted = true;
	},

	_directEnsureFsDir(fsPath) {
		const state = aioli._directState();
		fsPath = aioli._directNormalizeFsPath(aioli._resolveFsPath(fsPath));
		if(fsPath === aioli.config.dirOpfs)
			return aioli.fs.lookupPath(aioli.config.dirOpfs).node;

		const parts = fsPath.slice(aioli.config.dirOpfs.length).split("/").filter(Boolean);
		let current = aioli.fs.lookupPath(aioli.config.dirOpfs).node;
		let currentOpfs = "";
		for(const part of parts) {
			currentOpfs += `/${part}`;
			if(!current.contents[part])
				current = state.fsType.createNode(current, part, 16895, 0, current.mount, currentOpfs);
			else
				current = current.contents[part];
		}
		return current;
	},

	_directEntryForFsPath(fsPath) {
		return aioli._directState().entries.get(aioli._directToOpfsPath(fsPath));
	},

	async _directEnsureDir(fsPath) {
		if(!aioli._supportsLegacyDirectOpfs())
			return;
		fsPath = aioli._directNormalizeFsPath(aioli._resolveFsPath(fsPath));
		if(fsPath === aioli.config.dirOpfs)
			return aioli._directEnsureFsDir(fsPath);
		await aioli._opfsLookup(aioli._directToOpfsPath(fsPath), { create: true, directory: true });
		return aioli._directEnsureFsDir(fsPath);
	},

	async _directPrepareFile(fsPath, options = {}) {
		if(!aioli._supportsLegacyDirectOpfs())
			throw new Error("Direct OPFS support is not available in this environment.");

		const state = aioli._directState();
		fsPath = aioli._directNormalizeFsPath(aioli._resolveFsPath(fsPath));
		const opfsPath = options.opfsPath || aioli._directToOpfsPath(fsPath);
		const dirFsPath = fsPath.split("/").slice(0, -1).join("/") || aioli.config.dirOpfs;
		await aioli._directEnsureDir(dirFsPath);
		const fileHandle = await aioli._opfsLookup(opfsPath, { create: options.create === true });
		let entry = state.entries.get(opfsPath);
		if(entry?.accessHandle && entry.fileHandle !== fileHandle) {
			entry.accessHandle.close();
			entry = null;
		}
		if(!entry) {
			const accessHandle = await fileHandle.createSyncAccessHandle();
			entry = {
				opfsPath,
				fileHandle,
				accessHandle,
				size: accessHandle.getSize(),
				timestamp: Date.now(),
				node: null,
			};
			state.entries.set(opfsPath, entry);
		}
		if(options.truncate === true) {
			entry.accessHandle.truncate(0);
			entry.accessHandle.flush();
			entry.size = 0;
			entry.timestamp = Date.now();
		} else {
			entry.size = entry.accessHandle.getSize();
		}

		const info = aioli.fs.analyzePath(fsPath);
		let node = info.exists ? info.object : null;
		if(!node) {
			const parent = aioli._directEnsureFsDir(dirFsPath);
			node = state.fsType.createNode(parent, fsPath.split("/").pop(), 33279, 0, parent.mount, opfsPath);
		}
		node.opfsEntry = entry;
		node.timestamp = entry.timestamp;
		entry.node = node;
		return entry;
	},

	_directForgetPath(fsPath, options = {}) {
		if(!aioli.directOpfs)
			return;
		fsPath = aioli._directNormalizeFsPath(aioli._resolveFsPath(fsPath));
		const opfsPath = aioli._directToOpfsPath(fsPath);
		for(const [key, entry] of aioli.directOpfs.entries.entries()) {
			if(key === opfsPath || (options.recursive === true && key.startsWith(`${opfsPath}/`))) {
				try {
					entry.accessHandle?.close();
				} catch (error) {}
				aioli.directOpfs.entries.delete(key);
			}
		}
	},

	_moduleSupportsDirectOpfs(module) {
		return typeof module?.mountOpfs === "function" && module.mountOpfs.__biowasmStub !== true;
	},

	// Log if debug enabled
	_log(message) {
		if(!aioli.config.debug)
			return;

		// Support custom %c arguments
		let args = [...arguments];
		args.shift();
		console.log(`%c[WebWorker]%c ${message}`, "font-weight:bold", "", ...args);
	}
};

expose(aioli);
