import * as vscode from 'vscode';
import { spawn, execSync, ChildProcess } from 'child_process';

// --- État global ---
let shopifyProcess: ChildProcess | undefined;
let isConnected = false;
let storeUrl = '';
let localUrl = '';
let shareUrl = '';
let adminUrl = '';
let outputChannel: vscode.OutputChannel;
let buffer = '';
let hasError = false;
let crashed = false;
let intentionalDisconnect = false;

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
                this.tooltip = 'Cliquer pour modifier';
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
                this.tooltip = url ?? 'En attente...';
                break;
            case 'logs':
                this.iconPath = new vscode.ThemeIcon(
                    hasError ? 'warning' : 'output',
                    hasError ? new vscode.ThemeColor('problemsWarningIcon.foreground') : undefined
                );
                this.label = hasError ? 'Logs (⚠ erreur)' : 'Voir les logs';
                this.tooltip = hasError ? 'Erreur détectée — cliquer pour voir' : 'Voir les logs';
                this.command = { command: 'co-store.showLogs', title: 'Voir les logs' };
                break;
        }
    }
}

// --- TreeDataProvider ---

class ShopifyDevProvider implements vscode.TreeDataProvider<ShopifyItem> {
    private _onDidChangeTreeData = new vscode.EventEmitter<ShopifyItem | undefined | null | void>();
    readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

    refresh(): void { this._onDidChangeTreeData.fire(); }
    getTreeItem(element: ShopifyItem): vscode.TreeItem { return element; }

    getChildren(element?: ShopifyItem): ShopifyItem[] {
        if (!element) {
            const items: ShopifyItem[] = [
                new ShopifyItem(
                    storeUrl ? `Boutique: ${storeUrl}` : 'Boutique: ...',
                    vscode.TreeItemCollapsibleState.None, 'store'
                ),
                new ShopifyItem(
                    isConnected ? 'Statut: Connecté' : crashed ? 'Statut: Crash — reclique ▶' : 'Statut: Déconnecté',
                    vscode.TreeItemCollapsibleState.None, 'status'
                ),
            ];

            if (isConnected || localUrl || shareUrl || adminUrl) {
                items.push(new ShopifyItem('Liens', vscode.TreeItemCollapsibleState.Expanded, 'links'));
            }
            if (isConnected || hasError || localUrl) {
                items.push(new ShopifyItem('Voir les logs', vscode.TreeItemCollapsibleState.None, 'logs'));
            }
            return items;
        }

        if (element.itemType === 'links') {
            return [
                new ShopifyItem(
                    localUrl ? `Local` : 'Local: en attente...',
                    vscode.TreeItemCollapsibleState.None, 'link',
                    localUrl || undefined
                ),
                new ShopifyItem(
                    shareUrl ? 'Share (aperçu public)' : 'Share: en attente...',
                    vscode.TreeItemCollapsibleState.None, 'link',
                    shareUrl || undefined
                ),
                new ShopifyItem(
                    adminUrl ? 'Admin (éditeur de thème)' : 'Admin: en attente...',
                    vscode.TreeItemCollapsibleState.None, 'link',
                    adminUrl || undefined
                ),
            ];
        }
        return [];
    }
}

// --- Parsing ---

function parseOutput(text: string): void {
    outputChannel.append(text);
    buffer += text;

    // Nettoyage ANSI + OSC (hyperliens terminal, ex: \x1B]8;;URL\x1B\\ ou \x1B]8;;\x07)
    const clean = buffer
        .replace(/\x1B\][^\x07\x1B]*(?:\x07|\x1B\\)/g, '')  // OSC sequences (inkl. OSC 8 hyperlinks)
        .replace(/\x1B\[[0-9;]*[mGKHFJK]/g, '')
        .replace(/\x1B\[\??\d+[hl]/g, '')
        .replace(/\x1B[()][AB012]/g, '')                      // charset sequences
        .replace(/\x1B[@-Z\\-_]/g, '');                       // Fe escape sequences restantes

    let changed = false;

    // Local: http://127.0.0.1:PORT (on prend juste host:port)
    if (!localUrl) {
        const m = clean.match(/http:\/\/127\.0\.0\.1:(\d+)/);
        if (m) { localUrl = `http://127.0.0.1:${m[1]}`; changed = true; }
    }

    // Share: URL avec preview_theme_id
    if (!shareUrl) {
        const m = clean.match(/(https?:\/\/[^\s│╭╰╮╯\]\x00-\x1F]+preview_theme_id[^\s│╭╰╮╯\]\x00-\x1F]+)/);
        if (m) { shareUrl = m[1].replace(/[╭╰╮╯│─\]|]+$/, '').trim(); changed = true; }
    }

    // Admin: URL avec /admin/themes/ et editor (ou /admin/themes/ seul si pas d'editor dans l'URL)
    if (!adminUrl) {
        const m = clean.match(/(https?:\/\/[^\s│╭╰╮╯\]\x00-\x1F]+\/admin\/themes\/[^\s│╭╰╮╯\]\x00-\x1F]*(?:editor)?[^\s│╭╰╮╯\]\x00-\x1F]*)/);
        if (m) { adminUrl = m[1].replace(/[╭╰╮╯│─\]|]+$/, '').trim(); changed = true; }
    }

    // Auth Shopify
    const authM = clean.match(/(https?:\/\/accounts\.shopify\.[^\s│╭╰╮╯\]]+)/);
    if (authM) {
        vscode.env.openExternal(vscode.Uri.parse(authM[1]));
        vscode.window.showInformationMessage(
            'Shopify demande une auth — connecte-toi dans le navigateur puis reclique sur ▶'
        );
        buffer = ''; // reset après auth
    }

    // Détection d'erreur
    if (/\b(Error|EADDRINUSE|ETIMEDOUT|ECONNREFUSED|fatal|crash)\b/.test(buffer) && !hasError) {
        hasError = true;
        provider.refresh();
    }

    if (changed) { provider.refresh(); }

    // Garde seulement les derniers 10ko pour éviter la mémoire
    if (buffer.length > 10000) { buffer = buffer.slice(-5000); }
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
                storeUrl = input.trim().replace(/^https?:\/\//, '').replace(/\/$/, '');
                await context.workspaceState.update('co-store.storeUrl', storeUrl);
                provider.refresh();
            }
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('co-store.connect', async () => {
            if (!storeUrl) {
                const pick = await vscode.window.showErrorMessage(
                    'Aucune boutique définie.', 'Configurer maintenant'
                );
                if (pick) { await vscode.commands.executeCommand('co-store.setStore'); }
                return;
            }
            if (shopifyProcess) {
                vscode.window.showWarningMessage('Le serveur tourne déjà.');
                return;
            }

            const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
            localUrl = ''; shareUrl = ''; adminUrl = ''; buffer = ''; hasError = false; crashed = false; intentionalDisconnect = false;

            // Tue tout process qui occupe le port 9292 via Node.js directement
            try {
                const netstatOut = execSync('netstat -aon', { shell: 'cmd.exe', timeout: 3000 }).toString();
                for (const line of netstatOut.split('\n')) {
                    if (line.includes('127.0.0.1:9292') && line.includes('LISTENING')) {
                        const parts = line.trim().split(/\s+/);
                        const pid = parseInt(parts[parts.length - 1]);
                        if (!isNaN(pid) && pid > 0) {
                            try { execSync(`taskkill /F /T /PID ${pid}`, { shell: 'cmd.exe' }); } catch (_) {}
                        }
                    }
                }
                await new Promise(r => setTimeout(r, 1000));
            } catch (_) { /* port déjà libre */ }

            outputChannel.clear();
            outputChannel.appendLine(`▶ shopify theme dev --no-color -s ${storeUrl}`);
            outputChannel.appendLine('──────────────────────────────────────');

            shopifyProcess = spawn(
                'shopify',
                ['theme', 'dev', '--no-color', '-s', storeUrl],
                { shell: true, cwd }
            );

            isConnected = true;
            vscode.commands.executeCommand('setContext', 'co-store.isConnected', true);
            provider.refresh();

            shopifyProcess.stdout?.on('data', (d: Buffer) => parseOutput(d.toString()));
            shopifyProcess.stderr?.on('data', (d: Buffer) => parseOutput(d.toString()));

            shopifyProcess.on('close', (code) => {
                isConnected = false;
                shopifyProcess = undefined;
                vscode.commands.executeCommand('setContext', 'co-store.isConnected', false);
                provider.refresh();
                if (!intentionalDisconnect && !crashed && code !== 0 && code !== null && code !== 143) {
                    crashed = true;
                    vscode.window.showErrorMessage(
                        `shopify theme dev s'est arrêté (code ${code}).`,
                        'Voir les logs'
                    ).then(c => { if (c) { outputChannel.show(true); } });
                }
            });

            shopifyProcess.on('error', (err) => {
                vscode.window.showErrorMessage(`Impossible de lancer shopify: ${err.message}`);
                isConnected = false;
                crashed = true;
                shopifyProcess = undefined;
                vscode.commands.executeCommand('setContext', 'co-store.isConnected', false);
                provider.refresh();
            });
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('co-store.disconnect', () => {
            intentionalDisconnect = true;
            if (shopifyProcess) {
                try {
                    if (shopifyProcess.pid) {
                        execSync(`taskkill /F /T /PID ${shopifyProcess.pid}`, { shell: 'cmd.exe' });
                    } else {
                        shopifyProcess.kill();
                    }
                } catch (_) {}
                shopifyProcess = undefined;
            }
            // Libère le port 9292 même si le PID était inconnu
            try {
                const out = execSync('netstat -aon', { shell: 'cmd.exe', timeout: 3000 }).toString();
                for (const line of out.split('\n')) {
                    if (line.includes('127.0.0.1:9292') && line.includes('LISTENING')) {
                        const pid = parseInt(line.trim().split(/\s+/).pop() ?? '');
                        if (!isNaN(pid) && pid > 0) {
                            try { execSync(`taskkill /F /T /PID ${pid}`, { shell: 'cmd.exe' }); } catch (_) {}
                        }
                    }
                }
            } catch (_) {}
            isConnected = false; crashed = false;
            localUrl = ''; shareUrl = ''; adminUrl = '';
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
    if (shopifyProcess) {
        intentionalDisconnect = true;
        try {
            if (shopifyProcess.pid) {
                execSync(`taskkill /F /T /PID ${shopifyProcess.pid}`, { shell: 'cmd.exe' });
            } else {
                shopifyProcess.kill();
            }
        } catch (_) {}
    }
}
