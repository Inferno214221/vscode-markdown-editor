import * as vscode from 'vscode'
import * as NodePath from 'path'
const KeyVditorOptions = 'vditor.options'

function debug(...args: any[]) {
  console.log(...args)
}

function showError(msg: string) {
  vscode.window.showErrorMessage(`[markdown-editor] ${msg}`)
}

export function activate(context: vscode.ExtensionContext) {
	context.subscriptions.push(MarkdownEditorProvider.register(context));

  context.globalState.setKeysForSync([KeyVditorOptions])
}

export class MarkdownEditorProvider implements vscode.CustomTextEditorProvider {
	constructor(private readonly context: vscode.ExtensionContext) { }

	public static register(context: vscode.ExtensionContext): vscode.Disposable {
		const provider = new MarkdownEditorProvider(context);
		const providerRegistration = vscode.window.registerCustomEditorProvider(
      "markdown-editor.markdownEditor",
      provider
    );
		return providerRegistration;
	}

  private getFolders(): vscode.Uri[] {
    const data = []
    for (let i = 65; i <= 90; i++) {
      data.push(vscode.Uri.file(`${String.fromCharCode(i)}:/`))
    }
    return data
  }

  private getWebviewOptions(
    uri?: vscode.Uri
  ): vscode.WebviewOptions & vscode.WebviewPanelOptions {
    return {
      // Enable javascript in the webview
      enableScripts: true,
      localResourceRoots: [vscode.Uri.file("/"), ...this.getFolders()],
      retainContextWhenHidden: true,
      enableCommandUris: true,
    }
  }

  static get config() {
    return vscode.workspace.getConfiguration('markdown-editor')
  }

	public async resolveCustomTextEditor(
		document: vscode.TextDocument,
		webviewPanel: vscode.WebviewPanel,
		_token: vscode.CancellationToken
	): Promise<void> {
    // Setup initial content for the webview
		webviewPanel.webview.options = this.getWebviewOptions(document.uri);
		webviewPanel.webview.html = this.getHtmlForWebview(webviewPanel.webview, document);

		function updateWebview() {
			webviewPanel.webview.postMessage({
				type: 'update',
				text: document.getText(),
			});
		}

		// Hook up event handlers so that we can synchronize the webview with the text document.
		//
		// The text document acts as our model, so we have to sync change in the document to our
		// editor and sync changes in the editor back to the document.
		// 
		// Remember that a single text document can also be shared between multiple custom
		// editors (this happens for example when you split a custom editor)

		const changeDocumentSubscription = vscode.workspace.onDidChangeTextDocument(e => {
			if (e.document.uri.toString() === document.uri.toString()) {
				updateWebview();
			}
		});

		// Make sure we get rid of the listener when our editor is closed.
		webviewPanel.onDidDispose(() => {
			changeDocumentSubscription.dispose();
		});

		// Receive message from the webview.
		webviewPanel.webview.onDidReceiveMessage(async (message) => {
			debug('msg from webview review', message, webviewPanel.active);

      const syncToEditor = async () => {
        debug('sync to editor', document, document.uri)
        if (document) {
          const edit = new vscode.WorkspaceEdit()
          edit.replace(
            document.uri,
            new vscode.Range(0, 0, document.lineCount, 0),
            message.content
          )
          await vscode.workspace.applyEdit(edit)
        } else {
          showError(`Cannot find original file to save!`)
        }
      };

      switch (message.command) {
        case 'ready':
          this.update({
            type: 'init',
            options: {
              useVscodeThemeColor: MarkdownEditorProvider.config.get<boolean>(
                'useVscodeThemeColor'
              ),
              ...this.context.globalState.get(KeyVditorOptions),
            },
            theme:
              vscode.window.activeColorTheme.kind ===
              vscode.ColorThemeKind.Dark
                ? 'dark'
                : 'light',
          }, webviewPanel, document);
          break
        case 'save-options':
          this.context.globalState.update(KeyVditorOptions, message.options)
          break
        case 'info':
          vscode.window.showInformationMessage(message.content)
          break
        case 'error':
          showError(message.content)
          break
        case 'edit': {
          // 只有当 webview 处于编辑状态时才同步到 vsc 编辑器，避免重复刷新
          if (webviewPanel.active) {
            await syncToEditor()
          }
          break
        }
        case 'reset-config': {
          await this.context.globalState.update(KeyVditorOptions, {})
          break
        }
        // case 'save': {
        //   await syncToEditor()
        //   await document.save()
        //   break
        // }
        case 'upload': {
          const assetsFolder = MarkdownEditorProvider.getAssetsFolder(document.uri)
          try {
            await vscode.workspace.fs.createDirectory(
              vscode.Uri.file(assetsFolder)
            )
          } catch (error) {
            console.error(error)
            showError(`Invalid image folder: ${assetsFolder}`)
          }
          await Promise.all(
            message.files.map(async (f: any) => {
              const content = Buffer.from(f.base64, 'base64')
              return vscode.workspace.fs.writeFile(
                vscode.Uri.file(NodePath.join(assetsFolder, f.name)),
                content
              )
            })
          )
          const files = message.files.map((f: any) =>
            NodePath.relative(
              NodePath.dirname(document.uri.fsPath),
              NodePath.join(assetsFolder, f.name)
            ).replace(/\\/g, '/')
          )
          webviewPanel.webview.postMessage({
            command: 'uploaded',
            files,
          })
          break
        }
        case 'open-link': {
          let url = message.href
          if (!/^http/.test(url)) {
            url = NodePath.resolve(document.uri.fsPath, '..', url)
          }
          vscode.commands.executeCommand('vscode.open', vscode.Uri.parse(url))
          break
        }
      }
		});

    updateWebview();
	}

  static getAssetsFolder(uri: vscode.Uri) {
    const imageSaveFolder = (
      MarkdownEditorProvider.config.get<string>('imageSaveFolder') || 'assets'
    )
      .replace(
        '${projectRoot}',
        vscode.workspace.getWorkspaceFolder(uri)?.uri.fsPath || ''
      )
      .replace('${file}', uri.fsPath)
      .replace(
        '${fileBasenameNoExtension}',
        NodePath.basename(uri.fsPath, NodePath.extname(uri.fsPath))
      )
      .replace('${dir}', NodePath.dirname(uri.fsPath))
    const assetsFolder = NodePath.resolve(
      NodePath.dirname(uri.fsPath),
      imageSaveFolder
    )
    return assetsFolder
  }

  private async update(
    props: {
      type?: 'init' | 'update'
      options?: any
      theme?: 'dark' | 'light'
    } = { options: void 0 },
    webviewPanel: vscode.WebviewPanel, document: vscode.TextDocument
  ) {
    const md = document.getText();
    webviewPanel.webview.postMessage({
      command: 'update',
      content: md,
      ...props,
    });
  }

  private getHtmlForWebview(webview: vscode.Webview, document: vscode.TextDocument) {
    const toUri = (f: string) =>
      webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, f))
    const baseHref =
      NodePath.dirname(
        webview.asWebviewUri(vscode.Uri.file(document.uri.fsPath)).toString()
      ) + '/'
    const toMediaPath = (f: string) => `media/dist/${f}`
    const JsFiles = ['main.js'].map(toMediaPath).map(toUri)
    const CssFiles = ['main.css'].map(toMediaPath).map(toUri)

    return (
      `<!DOCTYPE html>
			<html lang="en">
			<head>
				<meta charset="UTF-8">

				<meta name="viewport" content="width=device-width, initial-scale=1.0">
				<base href="${baseHref}" />


				${CssFiles.map((f) => `<link href="${f}" rel="stylesheet">`).join('\n')}

				<title>markdown editor</title>
        <style>` +
        MarkdownEditorProvider.config.get<string>('customCss') +
      `</style>
			</head>
			<body>
				<div id="app"></div>


				${JsFiles.map((f) => `<script src="${f}"></script>`).join('\n')}
			</body>
			</html>`
    )
  }
}