import * as vscode from 'vscode';
import { spawn, ChildProcess } from 'child_process';

// --- État global ---
let shopifyProcess: ChildProcess | undefined;
let isConnected = false;
let storeUrl = '';
let localUrl = '';
let shareUrl = '';
let adminUrl = '';
let outputChannel: vscode.OutputChannel;
let lineBuffer = '';
let hasError = false;
let authRequested = false;

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

// --- Parsing ligne par ligne ---

function parseLine(line: string): void {
    outputChannel.appendLine(line);

    // Nettoyage ANSI + caractères de boîte unicode
    const clean = line
        .replace(/\x1B\[[0-9;]*[mGKHF]/g, '')
        .replace(/[│╭╰╮╯─┌┐└┘├┤┬┴┼]/g, ' ');

    const localMatch = clean.match(/(https?:\/\/127\.0\.0\.1:\d+[^\s]*)/);
    const shareMatch = clean.match(/(https?:\/\/\S+preview_theme_id\S*)/);
    const adminMatch = clean.match(/(https?:\/\/\S+\/admin\/themes\/\S*\/editor\S*)/);

    // Détection du lien d'authentification Shopify → ouverture automatique
    const authMatch = clean.match(/(https?:\/\/accounts\.shopify\.[^\s]+)/);
    if (authMatch) {
        authRequested = true;
        vscode.env.openExternal(vscode.Uri.parse(authMatch[1]));
        vscode.window.showInformationMessage('Shopify demande une authentification — connecte-toi dans le navigateur puis reclique sur ▶');
    }

    // Détection d'erreur
    const isErrorLine = /\b(error|erreur|failed|fail|exception)\b/i.test(clean);
    if (isErrorLine && !hasError) { hasError = true; provider.refresh(); }

    let changed = false;
    if (localMatch && !localUrl) { localUrl = localMatch[1]; changed = true; }
    if (shareMatch && !shareUrl) { shareUrl = shareMatch[1]; changed = true; }
    if (adminMatch && !adminUrl) { adminUrl = adminMatch[1]; changed = true; }

    if (changed) { provider.refresh(); }
}

function onData(data: Buffer): void {
    lineBuffer += data.toString();
    const lines = lineBuffer.split(/\r?\n/);
    lineBuffer = lines.pop() ?? '';
    for (const line of lines) {
        parseLine(line);
    }
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

            if (shopifyProcess) {
                vscode.window.showWarningMessage('Le serveur est déjà en cours d\'exécution.');
                return;
            }

            const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;

            localUrl = '';
            shareUrl = '';
            adminUrl = '';
            lineBuffer = '';
            hasError = false;
            authRequested = false;
            isConnected = true;
            vscode.commands.executeCommand('setContext', 'co-store.isConnected', true);
            provider.refresh();

            outputChannel.clear();
            outputChannel.appendLine(`▶ shopify theme dev -s ${storeUrl}`);
            outputChannel.appendLine('─────────────────────────────');

            shopifyProcess = spawn('shopify', ['theme', 'dev', '-s', storeUrl], {
                shell: true,
                cwd,
                env: { ...process.env, FORCE_COLOR: '0' }
            });

            shopifyProcess.stdout?.on('data', onData);
            shopifyProcess.stderr?.on('data', onData);

            shopifyProcess.on('close', (code) => {
                if (lineBuffer) { parseLine(lineBuffer); lineBuffer = ''; }
                isConnected = false;
                shopifyProcess = undefined;
                vscode.commands.executeCommand('setContext', 'co-store.isConnected', false);
                provider.refresh();
                if (code !== 0 && code !== null && !authRequested) {
                    outputChannel.appendLine(`\n⚠ Processus arrêté (code ${code})`);
                    vscode.window.showErrorMessage(
                        `shopify theme dev s'est arrêté (code ${code}).`,
                        'Voir les logs'
                    ).then(choice => {
                        if (choice === 'Voir les logs') { outputChannel.show(true); }
                    });
                }
                authRequested = false;
            });

            shopifyProcess.on('error', (err) => {
                vscode.window.showErrorMessage(`Impossible de lancer shopify: ${err.message}`);
                isConnected = false;
                shopifyProcess = undefined;
                vscode.commands.executeCommand('setContext', 'co-store.isConnected', false);
                provider.refresh();
            });
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('co-store.disconnect', () => {
            if (shopifyProcess) { shopifyProcess.kill(); shopifyProcess = undefined; }
            isConnected = false;
            localUrl = '';
            shareUrl = '';
            adminUrl = '';
            vscode.commands.executeCommand('setContext', 'co-store.isConnected', false);
            provider.refresh();
            vscode.window.showInformationMessage('Serveur arrêté.');
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
    if (shopifyProcess) { shopifyProcess.kill(); }
}
