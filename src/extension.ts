import * as vscode from 'vscode';
import { spawn, ChildProcess } from 'child_process';

// --- État global ---
let shopifyProcess: ChildProcess | undefined;
let isConnected = false;
let storeUrl = '';
let localUrl = '';
let shareUrl = '';
let adminUrl = '';

let provider: ShopifyDevProvider;

// --- Modèle ---

class ShopifyItem extends vscode.TreeItem {
    constructor(
        public readonly label: string,
        public readonly collapsibleState: vscode.TreeItemCollapsibleState,
        public readonly itemType: 'store' | 'status' | 'links' | 'link',
        public readonly url?: string
    ) {
        super(label, collapsibleState);

        switch (itemType) {
            case 'store':
                this.iconPath = new vscode.ThemeIcon('globe');
                this.command = { command: 'co-store.setStore', title: 'Définir la boutique' };
                this.tooltip = 'Cliquer pour modifier l\'URL de la boutique';
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
            const storeLabel = storeUrl
                ? `Boutique: ${storeUrl}`
                : 'Boutique: (non définie — cliquer pour configurer)';

            const statusLabel = isConnected ? 'Statut: Connecté' : 'Statut: Déconnecté';

            const items: ShopifyItem[] = [
                new ShopifyItem(storeLabel, vscode.TreeItemCollapsibleState.None, 'store'),
                new ShopifyItem(statusLabel, vscode.TreeItemCollapsibleState.None, 'status'),
            ];

            if (isConnected) {
                items.push(new ShopifyItem(
                    'Liens',
                    vscode.TreeItemCollapsibleState.Expanded,
                    'links'
                ));
            }

            return items;
        }

        if (element.itemType === 'links') {
            const links: ShopifyItem[] = [];

            if (localUrl) {
                links.push(new ShopifyItem(
                    `Local: ${localUrl}`,
                    vscode.TreeItemCollapsibleState.None,
                    'link',
                    localUrl
                ));
            } else {
                links.push(new ShopifyItem(
                    'Local: en attente...',
                    vscode.TreeItemCollapsibleState.None,
                    'link'
                ));
            }

            if (shareUrl) {
                links.push(new ShopifyItem(
                    'Share (aperçu public)',
                    vscode.TreeItemCollapsibleState.None,
                    'link',
                    shareUrl
                ));
            } else {
                links.push(new ShopifyItem(
                    'Share: en attente...',
                    vscode.TreeItemCollapsibleState.None,
                    'link'
                ));
            }

            if (adminUrl) {
                links.push(new ShopifyItem(
                    'Admin (éditeur de thème)',
                    vscode.TreeItemCollapsibleState.None,
                    'link',
                    adminUrl
                ));
            } else {
                links.push(new ShopifyItem(
                    'Admin: en attente...',
                    vscode.TreeItemCollapsibleState.None,
                    'link'
                ));
            }

            return links;
        }

        return [];
    }
}

// --- Parsing du stdout ---

function parseOutput(text: string): void {
    // Nettoyage des caractères ANSI et de boîte unicode
    const clean = text.replace(/\x1B\[[0-9;]*m/g, '').replace(/[│╭╰╮╯─]/g, '');

    const localMatch = clean.match(/(http:\/\/127\.0\.0\.1:\d+[^\s\]]*)/);
    const shareMatch = clean.match(/(https?:\/\/[^\s\]]*preview_theme_id[^\s\]]*)/);
    const adminMatch = clean.match(/(https?:\/\/[^\s\]]*\/admin\/themes\/[^\s\]]*\/editor[^\s\]]*)/);

    let changed = false;
    if (localMatch && !localUrl) { localUrl = localMatch[1].replace(/[^\w:/.-]/g, ''); changed = true; }
    if (shareMatch && !shareUrl) { shareUrl = shareMatch[1].replace(/[^\w:/.-?=&]/g, ''); changed = true; }
    if (adminMatch && !adminUrl) { adminUrl = adminMatch[1].replace(/[^\w:/.-?=&]/g, ''); changed = true; }

    if (changed) { provider.refresh(); }
}

// --- Commandes ---

function registerCommands(context: vscode.ExtensionContext): void {

    // Définir la boutique
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

    // Connecter
    context.subscriptions.push(
        vscode.commands.registerCommand('co-store.connect', async () => {
            if (!storeUrl) {
                const pick = await vscode.window.showErrorMessage(
                    'Aucune boutique définie.',
                    'Configurer maintenant'
                );
                if (pick) {
                    await vscode.commands.executeCommand('co-store.setStore');
                }
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
            isConnected = true;
            vscode.commands.executeCommand('setContext', 'co-store.isConnected', true);
            provider.refresh();

            shopifyProcess = spawn('shopify', ['theme', 'dev', '-s', storeUrl], {
                shell: true,
                cwd
            });

            vscode.window.showInformationMessage(`Connexion à ${storeUrl}...`);

            shopifyProcess.stdout?.on('data', (data: Buffer) => {
                parseOutput(data.toString());
            });

            // Shopify CLI écrit souvent dans stderr aussi
            shopifyProcess.stderr?.on('data', (data: Buffer) => {
                parseOutput(data.toString());
            });

            shopifyProcess.on('close', (code) => {
                isConnected = false;
                shopifyProcess = undefined;
                vscode.commands.executeCommand('setContext', 'co-store.isConnected', false);
                provider.refresh();

                if (code !== 0 && code !== null && code !== undefined) {
                    vscode.window.showErrorMessage(
                        `shopify theme dev s'est arrêté (code ${code}).`
                    );
                }
            });

            shopifyProcess.on('error', (err) => {
                vscode.window.showErrorMessage(
                    `Impossible de lancer shopify: ${err.message}. Vérifiez que la CLI Shopify est installée.`
                );
                isConnected = false;
                shopifyProcess = undefined;
                vscode.commands.executeCommand('setContext', 'co-store.isConnected', false);
                provider.refresh();
            });
        })
    );

    // Déconnecter
    context.subscriptions.push(
        vscode.commands.registerCommand('co-store.disconnect', () => {
            if (shopifyProcess) {
                shopifyProcess.kill();
                shopifyProcess = undefined;
            }
            isConnected = false;
            localUrl = '';
            shareUrl = '';
            adminUrl = '';
            vscode.commands.executeCommand('setContext', 'co-store.isConnected', false);
            provider.refresh();
            vscode.window.showInformationMessage('Serveur arrêté.');
        })
    );

    // Ouvrir un lien
    context.subscriptions.push(
        vscode.commands.registerCommand('co-store.openLink', (url: string) => {
            if (url) {
                vscode.env.openExternal(vscode.Uri.parse(url));
            }
        })
    );
}

// --- Point d'entrée ---

export function activate(context: vscode.ExtensionContext): void {
    // Récupère la boutique sauvegardée pour ce workspace
    storeUrl = context.workspaceState.get<string>('co-store.storeUrl', '');

    provider = new ShopifyDevProvider();
    vscode.window.registerTreeDataProvider('coStoreView', provider);

    vscode.commands.executeCommand('setContext', 'co-store.isConnected', false);

    registerCommands(context);
}

export function deactivate(): void {
    if (shopifyProcess) {
        shopifyProcess.kill();
    }
}
