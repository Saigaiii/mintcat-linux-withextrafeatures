// 类型导出
export type {
    SearchResultItem,
    SearchParams,
    SearchResult,
    SearchProviderStatus,
} from './types';

export {SearchSource, isRepositorySource} from './types';
export type {SearchSourceKey, RepositorySourceKey} from './types';

// 接口导出
export type {ISearchProvider} from './ISearchProvider';
export {SearchProviderRegistry} from './ISearchProvider';

// 提供者实现导出
export {ModioSearchProvider, getModioSearchProvider} from './ModioSearchProvider';
export {ModcatSearchProvider, getModcatSearchProvider} from './ModcatSearchProvider';
export {NexusModsSearchProvider, getNexusModsSearchProvider} from './NexusModsSearchProvider';
export {RepositorySearchProvider, repositorySourceKey} from './RepositorySearchProvider';
export type {RepositoryResultData} from './RepositorySearchProvider';

// 初始化搜索提供者注册
import {SearchProviderRegistry} from './ISearchProvider';
import {getModioSearchProvider} from './ModioSearchProvider';
import {getModcatSearchProvider} from './ModcatSearchProvider';
import {getNexusModsSearchProvider} from './NexusModsSearchProvider';
import {RepositorySearchProvider} from './RepositorySearchProvider';
import {isRepositorySource} from './types';
import {RepositoryStore} from '@/apis/repositories';

/**
 * 初始化并注册所有搜索提供者
 */
export function initializeSearchProviders(): void {
    const registry = SearchProviderRegistry.getInstance();
    
    // 注册 mod.io 搜索提供者
    registry.register(getModioSearchProvider());
    
    // 注册 ModCat 搜索提供者
    registry.register(getModcatSearchProvider());

    // 注册 Nexus Mods 搜索提供者
    registry.register(getNexusModsSearchProvider());

    // 未来可以在这里添加更多搜索提供者
    // registry.register(getThunderstoreSearchProvider());
}

/**
 * Register one provider per user-added repository (replacing previous ones).
 */
export async function syncRepositoryProviders(): Promise<void> {
    const registry = SearchProviderRegistry.getInstance();
    for (const source of registry.getSources()) {
        if (isRepositorySource(source)) registry.unregister(source);
    }
    for (const repo of await RepositoryStore.list()) {
        registry.register(new RepositorySearchProvider(repo));
    }
}
