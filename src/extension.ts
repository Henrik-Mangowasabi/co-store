import * as vscode from 'vscode';
import { ChildProcess } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

// --- État global ---
let shopifyProcess: ChildProcess | undefined;
let shopifyTerminal: vscode.Terminal | undefined;
let isConnected = false;
let storeUrl = '';
let localUrl = '';
let shareUrl = '';
let adminUrl = '';
let outputChannel: vscode.OutputChannel;
let hasError = false;
let authRequested = false;
let logFile = '';
let logWatcher: fs.FSWatcher | undefined;
let accumulatedOutput = '';

let provider: ShopifyDevProvider;

// --- Modèle ---

class ShopifyItem extends vscode.TreeItem {
    constructor(
        public readonly label: string,
        public readonly collapsibleState: vscode.TreeItemCollapsibleState,
        public readonly itemType: 'store' | 'status' | 'links' | 'link' | 'logs',
        public readonly url?: string
    ) {
        super(label, collapsibleState);

        switch (itemType) {
            case 'store':
                this.iconPath = new vscode.ThemeIcon('edit');
                this.command = { command: 'co-store.setStore', title: 'Définir la boutique' };
                this.tooltip = 'Cliquer pour saisir l\'URL de la boutique';
                this.description = storeUrl ? '← modifier' : '← cliquer pour saisir';
                break;

            case 'status':
                this.iconPath = new vscode.ThemeIcon(
                    isConnected ? 'circle-filled' : 'circle-outline',
                    isConnected
                        ? new vscode.ThemeColor('charts.green')
                        : new vscode.ThemeColor('charts.red')
                );
                break;

            case 'links':
                this.iconPath = new vscode.ThemeIcon('link');
                break;

            case 'link':
                this.iconPath = new vscode.ThemeIcon('link-external');
                if (url) {
                    this.command = {
                        command: 'co-store.openLink',
                        title: 'Ouvrir dans le navigateur',
                        arguments: [url]
                    };
                }
                this.tooltip = url;
                break;

            case 'logs':
                this.iconPath = new vscode.ThemeIcon(
                    hasError ? 'warning' : 'output',
                    hasError ? new vscode.ThemeColor('problemsWarningIcon.foreground') : undefined
                );
                this.command = { command: 'co-store.showLogs', title: 'Voir les logs' };
                this.tooltip = hasError ? 'Erreur détectée — cliquer pour voir les logs' : 'Voir les logs';
                this.label = hasError ? 'Logs (⚠ erreur)' : 'Voir les logs';
                break;
        }
    }
}

// --- TreeDataProvider ---

class ShopifyDevProvider implements vscode.TreeDataProvider<ShopifyItem> {
    private _onDidChangeTreeData = new vscode.EventEmitter<ShopifyItem | undefined | null | void>();
    readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

    refresh(): void {
        this._onDidChangeTreeData.fire();
    }

    getTreeItem(element: ShopifyItem): vscode.TreeItem {
        return element;
    }

    getChildren(element?: ShopifyItem): ShopifyItem[] {
        if (!element) {
            const storeLabel = storeUrl ? `Boutique: ${storeUrl}` : 'Boutique: ...';
            const statusLabel = isConnected ? 'Statut: Connecté' : 'Statut: Déconnecté';

            const items: ShopifyItem[] = [
                new ShopifyItem(storeLabel, vscode.TreeItemCollapsibleState.None, 'store'),
                new ShopifyItem(statusLabel, vscode.TreeItemCollapsibleState.None, 'status'),
            ];

            const hasLinks = localUrl || shareUrl || adminUrl;
            if (isConnected || hasLinks) {
                items.push(new ShopifyItem('Liens', vscode.TreeItemCollapsibleState.Expanded, 'links'));
            }
            if (isConnected) {
                items.push(new ShopifyItem('Voir les logs', vscode.TreeItemCollapsibleState.None, 'logs'));
            }

            return items;
        }

        if (element.itemType === 'links') {
            return [
                localUrl
                    ? new ShopifyItem(`Local: ${localUrl}`, vscode.TreeItemCollapsibleState.None, 'link', localUrl)
                    : new ShopifyItem('Local: en attente...', vscode.TreeItemCollapsibleState.None, 'link'),
                shareUrl
                    ? new ShopifyItem('Share (aperçu public)', vscode.TreeItemCollapsibleState.None, 'link', shareUrl)
                    : new ShopifyItem('Share: en attente...', vscode.TreeItemCollapsibleState.None, 'link'),
                adminUrl
                    ? new ShopifyItem('Admin (éditeur de thème)', vscode.TreeItemCollapsibleState.None, 'link', adminUrl)
                    : new ShopifyItem('Admin: en attente...', vscode.TreeItemCollapsibleState.None, 'link'),
            ];
        }

        return [];
    }
}

// --- Parsing de l'output accumulé ---

function parseAccumulated(text: string): void {
    // Nettoyage ANSI + box-drawing
    const clean = text
        .replace(/\x1B\[[0-9;]*[mGKHFJK]/g, '')
        .replace(/\x1B\[\??\d+[hl]/g, '')
        .replace(/[│╭╰╮╯─┌┐└┘├┤┬┴┼█▀▄]/g, ' ');

    // Extraction large de toutes les URLs
    const allUrls = clean.match(/https?:\/\/[^\s"'<>\]|]+/g) || [];
    let changed = false;

    for (const rawUrl of allUrls) {
        const url = rawUrl.replace(/[.,;:)]+$/, ''); // Retire ponctuation finale

        if (!localUrl && (url.includes('127.0.0.1') || url.includes('localhost'))) {
            localUrl = url; changed = true;
        } else if (!shareUrl && url.includes('preview_theme_id')) {
            shareUrl = url; changed = true;
        } else if (!adminUrl && url.includes('/admin/themes/') && url.includes('editor')) {
            adminUrl = url; changed = true;
        } else if (!authRequested && url.includes('accounts.shopify')) {
            authRequested = true;
            vscode.env.openExternal(vscode.Uri.parse(url));
            vscode.window.showInformationMessage(
                'Shopify demande une authentification — connecte-toi dans le navigateur puis reclique sur ▶'
            );
        }
    }

    const isErrorLine = /\b(AggregateError|ETIMEDOUT|ECONNREFUSED|ENOTFOUND|fatal|crash)\b/i.test(clean);
    if (isErrorLine && !hasError) { hasError = true; provider.refresh(); }

    if (changed) { provider.refresh(); }
}

function onData(data: Buffer): void {
    const text = data.toString();
    outputChannel.append(text);
    accumulatedOutput += text;
    parseAccumulated(text);
}

function stopProcess(): void {
    if (logWatcher) { logWatcher.close(); logWatcher = undefined; }
    if (shopifyProcess) { shopifyProcess.kill(); shopifyProcess = undefined; }
    if (shopifyTerminal) { shopifyTerminal.dispose(); shopifyTerminal = undefined; }
    if (logFile && fs.existsSync(logFile)) { try { fs.unlinkSync(logFile); } catch (_) { } }
    isConnected = false;
    vscode.commands.executeCommand('setContext', 'co-store.isConnected', false);
    provider.refresh();
}

// --- Commandes ---

function registerCommands(context: vscode.ExtensionContext): void {

    context.subscriptions.push(
        vscode.commands.registerCommand('co-store.setStore', async () => {
            const input = await vscode.window.showInputBox({
                prompt: 'URL de votre boutique Shopify',
                placeHolder: 'ex: mon-store.myshopify.com',
                value: storeUrl,
                ignoreFocusOut: true
            });
            if (input !== undefined) {
                storeUrl = input.trim();
                await context.workspaceState.update('co-store.storeUrl', storeUrl);
                provider.refresh();
            }
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('co-store.connect', async () => {
            if (!storeUrl) {
                const pick = await vscode.window.showErrorMessage('Aucune boutique définie.', 'Configurer maintenant');
                if (pick) { await vscode.commands.executeCommand('co-store.setStore'); }
                return;
            }
            if (shopifyProcess || shopifyTerminal) {
                vscode.window.showWarningMessage('Le serveur est déjà en cours d\'exécution.');
                return;
            }

            const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
            localUrl = ''; shareUrl = ''; adminUrl = '';
            hasError = false; authRequested = false; accumulatedOutput = '';
            isConnected = true;
            vscode.commands.executeCommand('setContext', 'co-store.isConnected', true);

            outputChannel.clear();
            outputChannel.appendLine(`▶ shopify theme dev -s ${storeUrl}`);
            outputChannel.appendLine('─────────────────────────────');
            provider.refresh();

            // Fichier temp pour capturer l'output du terminal
            logFile = path.join(os.tmpdir(), `shopify-dev-${Date.now()}.log`);

            // Lance dans un terminal VS Code (vrai TTY) avec tee vers le fichier log
            const cmd = process.platform === 'win32'
                ? `shopify theme dev -s ${storeUrl} | Tee-Object -FilePath "${logFile}"`
                : `shopify theme dev -s ${storeUrl} 2>&1 | tee "${logFile}"`;

            shopifyTerminal = vscode.window.createTerminal({
                name: 'Shopify Theme Dev',
                cwd
            });
            shopifyTerminal.sendText(cmd);

            // Surveille le fichier log pour parser les URLs
            let lastSize = 0;
            logWatcher = fs.watch(logFile, () => {
                try {
                    const stat = fs.statSync(logFile);
                    if (stat.size > lastSize) {
                        const buf = Buffer.alloc(stat.size - lastSize);
                        const fd = fs.openSync(logFile, 'r');
                        fs.readSync(fd, buf, 0, buf.length, lastSize);
                        fs.closeSync(fd);
                        lastSize = stat.size;
                        onData(buf);
                    }
                } catch (_) { }
            });

            // Détecte la fermeture du terminal
            context.subscriptions.push(
                vscode.window.onDidCloseTerminal(t => {
                    if (t === shopifyTerminal) {
                        shopifyTerminal = undefined;
                        isConnected = false;
                        vscode.commands.executeCommand('setContext', 'co-store.isConnected', false);
                        if (logWatcher) { logWatcher.close(); logWatcher = undefined; }
                        provider.refresh();
                    }
                })
            );
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('co-store.disconnect', () => {
            stopProcess();
            localUrl = ''; shareUrl = ''; adminUrl = '';
            vscode.window.showInformationMessage('Serveur arrêté.');
            provider.refresh();
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('co-store.openLink', (url: string) => {
            if (url) { vscode.env.openExternal(vscode.Uri.parse(url)); }
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('co-store.showLogs', () => {
            outputChannel.show(true);
        })
    );
}

// --- Point d'entrée ---

export function activate(context: vscode.ExtensionContext): void {
    storeUrl = context.workspaceState.get<string>('co-store.storeUrl', '');

    outputChannel = vscode.window.createOutputChannel('MM Store Connexion');
    context.subscriptions.push(outputChannel);

    provider = new ShopifyDevProvider();
    vscode.window.registerTreeDataProvider('coStoreView', provider);
    vscode.commands.executeCommand('setContext', 'co-store.isConnected', false);

    registerCommands(context);
}

export function deactivate(): void {
    stopProcess();
}
