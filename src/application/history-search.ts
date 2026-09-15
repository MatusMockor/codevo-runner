import { parseHistorySearch, type HistorySearchPage, type HistorySearchQuery } from '../domain/history-search.js';
export interface HistorySearchRepository { searchHistory(query: HistorySearchQuery): Promise<HistorySearchPage> }
export interface HistorySearchApplication { search(query: unknown): Promise<HistorySearchPage> }
export class HistorySearchService implements HistorySearchApplication {
  constructor(private readonly repository: HistorySearchRepository) {}
  search(query: unknown): Promise<HistorySearchPage> { return this.repository.searchHistory(parseHistorySearch(query)); }
}
