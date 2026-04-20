const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');

const preloadPath = path.join(__dirname, '..', 'preload.js');
const preloadSource = fs.readFileSync(preloadPath, 'utf8');

function loadLocalTools() {
  const sandbox = {
    require,
    console,
    process,
    Buffer,
    URL,
    AbortController,
    setTimeout,
    clearTimeout,
    fetch: global.fetch,
    window: {},
    module: { exports: {} },
    exports: {},
  };

  vm.runInNewContext(preloadSource, sandbox, { filename: 'preload.js' });
  return sandbox.window.localTools;
}

function createTempWorkspace() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'kukeagent-tools-'));
}

test('BashTool 可以执行命令', async () => {
  const tools = loadLocalTools();
  const result = await tools.BashTool(`node -e "process.stdout.write('bash-ok')"`);

  assert.equal(result.success, true);
  assert.match(result.stdout, /bash-ok/);
});

test('BashTool 大输出会自动截断 stdout', async () => {
  const tools = loadLocalTools();
  const command = `node -e "for (let i = 0; i < 1200; i++) process.stdout.write('line' + i + '\\n')"`;
  const result = await tools.BashTool(command);

  assert.equal(result.success, true);
  assert.equal(result.stdoutTruncated, true);
  assert.ok(result.stdoutOriginalLines >= 1200);
  assert.ok(result.stdout.includes('line0'));
  assert.ok(result.stdout.includes('line1199'));
  assert.ok(result.stdout.includes('truncated'));
  // saved bytes should be much smaller than original
  assert.ok(Buffer.byteLength(result.stdout, 'utf-8') < result.stdoutOriginalBytes);
});

test('SetWorkspaceRootTool + GetWorkspaceRootTool 可以切换/查询 cwd', async () => {
  const tools = loadLocalTools();
  const originalCwd = process.cwd();
  const workspace = createTempWorkspace();

  try {
    const setResult = tools.SetWorkspaceRootTool({ path: workspace });
    assert.equal(setResult.success, true);
    assert.equal(
      fs.realpathSync(setResult.data.cwd),
      fs.realpathSync(workspace),
    );

    const getResult = tools.GetWorkspaceRootTool();
    assert.equal(getResult.success, true);
    assert.equal(
      fs.realpathSync(getResult.data.cwd),
      fs.realpathSync(workspace),
    );
  } finally {
    process.chdir(originalCwd);
  }
});

test('FileReadTool / FileWriteTool / FileEditTool 可以读写编辑文件', async () => {
  const tools = loadLocalTools();
  const workspace = createTempWorkspace();
  const filePath = path.join(workspace, 'sample.txt');

  const writeResult = await tools.FileWriteTool(filePath, 'alpha\nbeta\n');
  assert.equal(writeResult.success, true);

  const readResult = await tools.FileReadTool(filePath);
  assert.equal(readResult.success, true);
  assert.equal(readResult.data.kind, 'text');
  assert.equal(readResult.data.totalLines, 2);
  assert.ok(readResult.data.content.includes('alpha'));
  assert.ok(readResult.data.content.includes('beta'));
  assert.match(readResult.data.content, /\s+1\t/);

  const editResult = await tools.FileEditTool({
    filePath,
    search: 'beta',
    replace: 'gamma',
  });
  assert.equal(editResult.success, true);

  const updatedContent = fs.readFileSync(filePath, 'utf8');
  assert.equal(updatedContent, 'alpha\ngamma\n');
});

test('FileReadTool offset/limit 可以分页读大文件', async () => {
  const tools = loadLocalTools();
  const workspace = createTempWorkspace();
  const filePath = path.join(workspace, 'big.txt');
  const lines = [];
  for (let i = 1; i <= 20; i += 1) lines.push(`line${i}`);
  fs.writeFileSync(filePath, lines.join('\n'), 'utf8');

  const sliced = await tools.FileReadTool({ filePath, offset: 5, limit: 3 });
  assert.equal(sliced.success, true);
  assert.equal(sliced.data.totalLines, 20);
  assert.equal(sliced.data.linesReturned, 3);
  assert.equal(sliced.data.truncated, true);
  assert.ok(sliced.data.content.includes('line6'));
  assert.ok(sliced.data.content.includes('line8'));
  assert.ok(!sliced.data.content.includes('line5'));
  assert.ok(!sliced.data.content.includes('line9'));
});

test('FileEditTool 支持 old_string/new_string 别名', async () => {
  const tools = loadLocalTools();
  const workspace = createTempWorkspace();
  const filePath = path.join(workspace, 'alias.txt');
  fs.writeFileSync(filePath, 'hello world\n', 'utf8');

  const result = await tools.FileEditTool({
    filePath,
    old_string: 'hello',
    new_string: 'hi',
  });
  assert.equal(result.success, true);
  assert.equal(fs.readFileSync(filePath, 'utf8'), 'hi world\n');
});

test('FileEditTool 返回 diff（行数 + unified 文本）', async () => {
  const tools = loadLocalTools();
  const workspace = createTempWorkspace();
  const filePath = path.join(workspace, 'diff-edit.txt');
  fs.writeFileSync(filePath, 'alpha\nbeta\ngamma\n', 'utf8');

  const result = await tools.FileEditTool({
    filePath,
    old_string: 'beta',
    new_string: 'BETA',
  });
  assert.equal(result.success, true);
  assert.ok(result.data.diff, 'diff 应该存在');
  assert.equal(result.data.diff.addedLines, 1);
  assert.equal(result.data.diff.removedLines, 1);
  assert.ok(result.data.diff.diffText.includes('-beta'));
  assert.ok(result.data.diff.diffText.includes('+BETA'));
  assert.match(result.data.diff.diffText, /^@@/m);
});

test('FileWriteTool 新建文件时 diff 全部是新增', async () => {
  const tools = loadLocalTools();
  const workspace = createTempWorkspace();
  const filePath = path.join(workspace, 'new.txt');

  const result = await tools.FileWriteTool(filePath, 'a\nb\nc\n');
  assert.equal(result.success, true);
  assert.equal(result.data.previouslyExisted, false);
  assert.equal(result.data.diff.addedLines, 3);
  assert.equal(result.data.diff.removedLines, 0);
});

test('FileWriteTool 覆盖已有文件时 diff 同时有新增和删除', async () => {
  const tools = loadLocalTools();
  const workspace = createTempWorkspace();
  const filePath = path.join(workspace, 'overwrite.txt');
  fs.writeFileSync(filePath, 'one\ntwo\n', 'utf8');

  const result = await tools.FileWriteTool(filePath, 'one\nTWO\nthree\n');
  assert.equal(result.success, true);
  assert.equal(result.data.previouslyExisted, true);
  assert.equal(result.data.diff.addedLines, 2);
  assert.equal(result.data.diff.removedLines, 1);
});

test('FileDeleteTool 文件 diff 全部是删除', async () => {
  const tools = loadLocalTools();
  const workspace = createTempWorkspace();
  const filePath = path.join(workspace, 'gone.txt');
  fs.writeFileSync(filePath, 'keep1\nkeep2\n', 'utf8');

  const result = await tools.FileDeleteTool({ filePath });
  assert.equal(result.success, true);
  assert.equal(result.data.diff.addedLines, 0);
  assert.equal(result.data.diff.removedLines, 2);
});

test('FileEditTool 在单次替换命中多处时会拒绝误改', async () => {
  const tools = loadLocalTools();
  const workspace = createTempWorkspace();
  const filePath = path.join(workspace, 'repeat.txt');

  fs.writeFileSync(filePath, 'x=1\nx=1\n', 'utf8');
  const result = await tools.FileEditTool({
    filePath,
    search: 'x=1',
    replace: 'x=2',
  });

  assert.equal(result.success, false);
  assert.match(result.error, /命中 2 处|replaceAll/);
});

test('GlobTool 和 GrepTool 可以检索文件与内容', async () => {
  const tools = loadLocalTools();
  const workspace = createTempWorkspace();
  const srcDir = path.join(workspace, 'src');
  const docsDir = path.join(workspace, 'docs');

  fs.mkdirSync(srcDir, { recursive: true });
  fs.mkdirSync(docsDir, { recursive: true });
  fs.writeFileSync(path.join(srcDir, 'main.ts'), 'const greeting = "hello tools"\n', 'utf8');
  fs.writeFileSync(path.join(docsDir, 'guide.md'), '# hello tools\n', 'utf8');

  const globResult = await tools.GlobTool({
    pattern: '**/*.ts',
    path: workspace,
  });
  assert.equal(globResult.success, true);
  assert.ok(globResult.data.some((item) => item.path.endsWith(path.join('src', 'main.ts'))));

  const grepFiles = await tools.GrepTool({
    pattern: 'hello tools',
    path: workspace,
    headLimit: 10,
  });
  assert.equal(grepFiles.success, true);
  assert.equal(grepFiles.data.outputMode, 'files_with_matches');
  assert.ok(grepFiles.data.paths.length >= 2);

  const grepContent = await tools.GrepTool({
    pattern: 'hello tools',
    path: workspace,
    outputMode: 'content',
  });
  assert.equal(grepContent.success, true);
  assert.ok(grepContent.data.matches.length >= 2);
  assert.ok(grepContent.data.matches[0].lineNumber >= 1);

  const grepCount = await tools.GrepTool({
    pattern: 'hello',
    path: workspace,
    outputMode: 'count',
  });
  assert.equal(grepCount.success, true);
  assert.ok(grepCount.data.counts.length >= 2);
  assert.ok(grepCount.data.totalMatches >= 2);
});

test('GrepTool content 模式支持上下文', async () => {
  const tools = loadLocalTools();
  const workspace = createTempWorkspace();
  const filePath = path.join(workspace, 'ctx.txt');
  fs.writeFileSync(
    filePath,
    ['aaa', 'bbb', 'NEEDLE', 'ccc', 'ddd', ''].join('\n'),
    'utf8',
  );

  const result = await tools.GrepTool({
    pattern: 'NEEDLE',
    path: workspace,
    outputMode: 'content',
    beforeContext: 2,
    afterContext: 2,
  });
  assert.equal(result.success, true);
  assert.equal(result.data.matches.length, 1);
  const match = result.data.matches[0];
  assert.equal(match.lineNumber, 3);
  assert.equal(match.beforeContext.length, 2);
  assert.equal(match.afterContext.length, 2);
  assert.equal(
    JSON.stringify(match.beforeContext.map((item) => item.line)),
    JSON.stringify(['aaa', 'bbb']),
  );
  assert.equal(
    JSON.stringify(match.afterContext.map((item) => item.line)),
    JSON.stringify(['ccc', 'ddd']),
  );
});

test('GrepTool type 过滤只扫指定扩展', async () => {
  const tools = loadLocalTools();
  const workspace = createTempWorkspace();
  fs.writeFileSync(path.join(workspace, 'keep.ts'), 'const x = 1\n', 'utf8');
  fs.writeFileSync(path.join(workspace, 'skip.md'), '# x = 1\n', 'utf8');

  const result = await tools.GrepTool({
    pattern: 'x = 1',
    path: workspace,
    type: 'ts',
    outputMode: 'content',
  });
  assert.equal(result.success, true);
  assert.equal(result.data.matches.length, 1);
  assert.ok(result.data.matches[0].path.endsWith('keep.ts'));
});

test('GrepTool multiline 可以跨行匹配', async () => {
  const tools = loadLocalTools();
  const workspace = createTempWorkspace();
  const filePath = path.join(workspace, 'ml.txt');
  fs.writeFileSync(filePath, 'class Foo {\n  bar(): void;\n}\n', 'utf8');

  const result = await tools.GrepTool({
    pattern: 'Foo\\s*\\{[\\s\\S]*?bar',
    path: workspace,
    outputMode: 'content',
    multiline: true,
  });
  assert.equal(result.success, true);
  assert.ok(result.data.matches.length >= 1);
});

test('GlobTool 按 mtime 倒序返回', async () => {
  const tools = loadLocalTools();
  const workspace = createTempWorkspace();
  const older = path.join(workspace, 'older.txt');
  const newer = path.join(workspace, 'newer.txt');
  fs.writeFileSync(older, 'old', 'utf8');
  const past = Date.now() / 1000 - 3600;
  fs.utimesSync(older, past, past);
  fs.writeFileSync(newer, 'new', 'utf8');

  const result = await tools.GlobTool({ pattern: '*.txt', path: workspace });
  assert.equal(result.success, true);
  assert.ok(result.data.length >= 2);
  assert.ok(result.data[0].path.endsWith('newer.txt'));
});

test('WebFetchTool 可以抓取并提取网页内容', async () => {
  const tools = loadLocalTools();
  const result = await tools.WebFetchTool('https://example.com/');
  assert.equal(result.success, true);
  assert.equal(result.data.status, 200);
  assert.match(result.data.content, /Example Domain/i);
});

test('WebSearchTool 可以通过 Tavily 真实返回搜索结果', {
  skip: process.env.TAVILY_API_KEY ? false : '未设置 TAVILY_API_KEY，跳过真实 Tavily 集成测试',
}, async () => {
  const tools = loadLocalTools();
  const result = await tools.WebSearchTool('OpenAI official website', 5, process.env.TAVILY_API_KEY);
  assert.equal(result.success, true);
  assert.equal(result.data.provider, 'Tavily');
  assert.ok(Array.isArray(result.data.results));
  assert.ok(result.data.results.length > 0);
  assert.ok(result.data.results.every((item) => item.title && item.url));
});

test('WebFetchTool 会拦截本地与内网地址', async () => {
  const tools = loadLocalTools();
  const result = await tools.WebFetchTool('http://localhost:3000');

  assert.equal(result.success, false);
  assert.match(result.error, /本地或内网地址/);
});

test('snapshotFile + restoreSnapshot 可以回滚 FileEditTool 的改动', async () => {
  const tools = loadLocalTools();
  const workspace = createTempWorkspace();
  const filePath = path.join(workspace, 'undo.txt');
  fs.writeFileSync(filePath, 'original line\n', 'utf8');

  const context = {
    sessionId: `test_session_${Date.now()}`,
    messageId: `test_msg_${Date.now()}`,
  };

  const snapshotResult = await tools.snapshotFile(context, filePath);
  assert.equal(snapshotResult.success, true);

  const editResult = await tools.FileEditTool({
    filePath,
    search: 'original',
    replace: 'edited',
  });
  assert.equal(editResult.success, true);
  assert.equal(fs.readFileSync(filePath, 'utf8'), 'edited line\n');

  const restoreResult = await tools.restoreSnapshot(context);
  assert.equal(restoreResult.success, true);
  assert.equal(restoreResult.data.restored, 1);
  assert.equal(fs.readFileSync(filePath, 'utf8'), 'original line\n');
});

test('restoreSnapshot 可以删除 AI 新建的文件', async () => {
  const tools = loadLocalTools();
  const workspace = createTempWorkspace();
  const newFile = path.join(workspace, 'created-by-ai.txt');
  assert.equal(fs.existsSync(newFile), false);

  const context = {
    sessionId: `test_session_${Date.now()}`,
    messageId: `test_msg_${Date.now()}`,
  };

  const snapshotResult = await tools.snapshotFile(context, newFile);
  assert.equal(snapshotResult.success, true);

  fs.writeFileSync(newFile, 'ai wrote this', 'utf8');
  assert.equal(fs.existsSync(newFile), true);

  const restoreResult = await tools.restoreSnapshot(context);
  assert.equal(restoreResult.success, true);
  assert.equal(restoreResult.data.deleted, 1);
  assert.equal(fs.existsSync(newFile), false);
});

test('FileDeleteTool 可以删文件且支持快照回滚', async () => {
  const tools = loadLocalTools();
  const workspace = createTempWorkspace();
  const filePath = path.join(workspace, 'to-delete.txt');
  fs.writeFileSync(filePath, 'please keep me', 'utf8');

  const context = {
    sessionId: `test_session_${Date.now()}`,
    messageId: `test_msg_${Date.now()}`,
  };

  const deleteResult = await tools.FileDeleteTool({
    filePath,
    __context: context,
  });
  assert.equal(deleteResult.success, true);
  assert.equal(fs.existsSync(filePath), false);

  const restoreResult = await tools.restoreSnapshot(context);
  assert.equal(restoreResult.success, true);
  assert.equal(restoreResult.data.restored, 1);
  assert.equal(fs.readFileSync(filePath, 'utf8'), 'please keep me');
});

test('FileDeleteTool 可以递归删目录并回滚整棵树', async () => {
  const tools = loadLocalTools();
  const workspace = createTempWorkspace();
  const folder = path.join(workspace, 'nested');
  fs.mkdirSync(path.join(folder, 'sub'), { recursive: true });
  fs.writeFileSync(path.join(folder, 'a.txt'), 'A', 'utf8');
  fs.writeFileSync(path.join(folder, 'sub', 'b.txt'), 'B', 'utf8');

  const context = {
    sessionId: `test_session_${Date.now()}`,
    messageId: `test_msg_${Date.now()}`,
  };

  const failsNoRecursive = await tools.FileDeleteTool({
    filePath: folder,
    __context: context,
  });
  assert.equal(failsNoRecursive.success, false);
  assert.match(failsNoRecursive.error, /recursive/);

  const deleted = await tools.FileDeleteTool({
    filePath: folder,
    recursive: true,
    __context: context,
  });
  assert.equal(deleted.success, true);
  assert.equal(fs.existsSync(folder), false);

  const restoreResult = await tools.restoreSnapshot(context);
  assert.equal(restoreResult.success, true);
  assert.equal(restoreResult.data.restored, 1);
  assert.equal(fs.readFileSync(path.join(folder, 'a.txt'), 'utf8'), 'A');
  assert.equal(fs.readFileSync(path.join(folder, 'sub', 'b.txt'), 'utf8'), 'B');
});

test('statPath 能识别文件与目录', async () => {
  const tools = loadLocalTools();
  const workspace = createTempWorkspace();
  const filePath = path.join(workspace, 'note.txt');
  fs.writeFileSync(filePath, 'hi', 'utf8');

  const fileStat = tools.statPath(filePath);
  assert.equal(fileStat.success, true);
  assert.equal(fileStat.data.exists, true);
  assert.equal(fileStat.data.isFile, true);
  assert.equal(fileStat.data.isDirectory, false);

  const dirStat = tools.statPath(workspace);
  assert.equal(dirStat.success, true);
  assert.equal(dirStat.data.isDirectory, true);

  const missing = tools.statPath(path.join(workspace, 'missing.txt'));
  assert.equal(missing.success, true);
  assert.equal(missing.data.exists, false);
});

test('saveClipboardImage 和 readFileAsDataURL 可以圆环跑通', async () => {
  const tools = loadLocalTools();
  // 1x1 绿色 PNG base64
  const dataUrl =
    'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYGD4DwABBAEAfbLI3wAAAABJRU5ErkJggg==';
  const saveResult = tools.saveClipboardImage(dataUrl, '.png');
  assert.equal(saveResult.success, true);
  assert.ok(saveResult.data.path.endsWith('.png'));
  assert.ok(fs.existsSync(saveResult.data.path));

  const readResult = tools.readFileAsDataURL(saveResult.data.path);
  assert.equal(readResult.success, true);
  assert.match(readResult.data.dataUrl, /^data:image\/png;base64,/);

  // cleanup
  fs.unlinkSync(saveResult.data.path);
});

test('saveUploadedFile 可以保存任意 dataUrl 并保留原文件名', async () => {
  const tools = loadLocalTools();
  const payload = 'hello upload';
  const base64 = Buffer.from(payload, 'utf-8').toString('base64');
  const dataUrl = `data:text/plain;base64,${base64}`;

  const result = tools.saveUploadedFile({ dataUrl, name: 'notes.txt' });
  assert.equal(result.success, true);
  assert.ok(result.data.path.endsWith('notes.txt'));
  assert.ok(fs.existsSync(result.data.path));
  assert.equal(fs.readFileSync(result.data.path, 'utf-8'), payload);

  fs.unlinkSync(result.data.path);
});

test('BashTool 后台模式 + BashOutputTool + KillShellTool 联动', async () => {
  const tools = loadLocalTools();
  const started = await tools.BashTool({
    command: 'node -e "let i=0;setInterval(()=>{process.stdout.write(`tick${++i}\\n`);if(i>20)process.exit(0);},80)"',
    runInBackground: true,
    description: 'tick emitter',
  });
  assert.equal(started.success, true, started.error || '启动失败');
  const { bashId } = started.data;
  assert.ok(bashId);

  await new Promise((resolve) => setTimeout(resolve, 500));

  const first = tools.BashOutputTool({ bashId });
  assert.equal(first.success, true);
  assert.ok(first.data.stdout.includes('tick'));
  assert.equal(first.data.status, 'running');

  const second = tools.BashOutputTool({ bashId });
  assert.equal(second.success, true);
  // second read should not include earlier ticks

  const killed = tools.KillShellTool({ bashId });
  assert.equal(killed.success, true);
  assert.ok(['killed', 'completed', 'exited'].includes(killed.data.status));

  await new Promise((resolve) => setTimeout(resolve, 200));
  const finalRead = tools.BashOutputTool({ bashId });
  assert.equal(finalRead.success, true);
  assert.notEqual(finalRead.data.status, 'running');
});

test('NotebookEditTool 可以 replace / insert / delete cell', async () => {
  const tools = loadLocalTools();
  const workspace = createTempWorkspace();
  const notebookPath = path.join(workspace, 'test.ipynb');
  fs.writeFileSync(
    notebookPath,
    JSON.stringify({
      cells: [
        { id: 'c1', cell_type: 'code', source: ['print("old")\n'], outputs: [], execution_count: null, metadata: {} },
      ],
      metadata: {},
      nbformat: 4,
      nbformat_minor: 5,
    }, null, 2),
    'utf8',
  );

  const replaced = await tools.NotebookEditTool({
    notebookPath,
    cellId: 'c1',
    editMode: 'replace',
    newSource: 'print("new")\n',
  });
  assert.equal(replaced.success, true);
  let parsed = JSON.parse(fs.readFileSync(notebookPath, 'utf8'));
  assert.equal(parsed.cells[0].source.join(''), 'print("new")\n');

  const inserted = await tools.NotebookEditTool({
    notebookPath,
    cellId: 'c1',
    editMode: 'insert',
    cellType: 'markdown',
    newSource: '# note\n',
  });
  assert.equal(inserted.success, true);
  parsed = JSON.parse(fs.readFileSync(notebookPath, 'utf8'));
  assert.equal(parsed.cells.length, 2);
  assert.equal(parsed.cells[1].cell_type, 'markdown');

  const removed = await tools.NotebookEditTool({
    notebookPath,
    cellId: parsed.cells[1].id,
    editMode: 'delete',
  });
  assert.equal(removed.success, true);
  parsed = JSON.parse(fs.readFileSync(notebookPath, 'utf8'));
  assert.equal(parsed.cells.length, 1);
});

test('TodoWriteTool 校验结构并拒绝多个 in_progress', async () => {
  const tools = loadLocalTools();
  const good = tools.TodoWriteTool({
    todos: [
      { content: '写测试', activeForm: '写测试中', status: 'in_progress' },
      { content: '跑构建', activeForm: '跑构建中', status: 'pending' },
    ],
  });
  assert.equal(good.success, true);
  assert.equal(good.data.todos.length, 2);
  assert.equal(good.data.summary.in_progress, 1);
  assert.equal(good.data.summary.pending, 1);

  const bad = tools.TodoWriteTool({
    todos: [
      { content: 'A', activeForm: 'A 中', status: 'in_progress' },
      { content: 'B', activeForm: 'B 中', status: 'in_progress' },
    ],
  });
  assert.equal(bad.success, false);
  assert.match(bad.error, /in_progress/);
});

test('WebSearchTool 域名过滤（仅在 TAVILY_API_KEY 存在时跑）', {
  skip: process.env.TAVILY_API_KEY ? false : '未设置 TAVILY_API_KEY，跳过真实 Tavily 集成测试',
}, async () => {
  const tools = loadLocalTools();
  const result = await tools.WebSearchTool({
    query: 'MDN fetch',
    count: 5,
    apiKey: process.env.TAVILY_API_KEY,
    allowedDomains: ['developer.mozilla.org'],
  });
  assert.equal(result.success, true);
  assert.ok(result.data.results.every((item) => {
    try {
      return new URL(item.url).hostname.endsWith('developer.mozilla.org');
    } catch {
      return false;
    }
  }));
});
