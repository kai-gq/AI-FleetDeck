/**
 * 数据库消息:连接测试/库列表/查询执行与结果/查询历史/表结构
 *
 * 自 websocket-messages.ts 按主题拆出(2026-10-11 W4 特例);块级逐行原样搬移。
 */

import { type WSMessage } from './base.js';
import { type QueryResult, type QueryHistoryEntry, type TableColumn, type TableIndex, type ForeignKey, type TableInfo } from '../database-types.js';

// ============================================================================
// Database Messages
// ============================================================================

// Test database connection (Client -> Server)
export interface TestDatabaseConnectionMessage extends WSMessage {
  type: 'test_database_connection';
  payload: {
    buildingId: string;
    connectionId: string;
  };
}

// Test an unsaved database connection — full connection object passed inline.
// Used by the "Test Connection" button before a building is persisted.
export interface TestDatabaseConnectionTransientMessage extends WSMessage {
  type: 'test_database_connection_transient';
  payload: {
    requestId: string;
    connection: import('../database-types.js').DatabaseConnection;
  };
}

// Test connection result (Server -> Client)
export interface DatabaseConnectionResultMessage extends WSMessage {
  type: 'database_connection_result';
  payload: {
    buildingId: string;
    connectionId: string;
    requestId?: string;            // Set when the test was a transient one
    success: boolean;
    error?: string;
    serverVersion?: string;
  };
}

// List databases (Client -> Server)
export interface ListDatabasesMessage extends WSMessage {
  type: 'list_databases';
  payload: {
    buildingId: string;
    connectionId: string;
  };
}

// Databases list result (Server -> Client)
export interface DatabasesListMessage extends WSMessage {
  type: 'databases_list';
  payload: {
    buildingId: string;
    connectionId: string;
    databases: string[];
  };
}

// Execute query (Client -> Server)
export interface ExecuteQueryMessage extends WSMessage {
  type: 'execute_query';
  payload: {
    buildingId: string;
    connectionId: string;
    database: string;
    query: string;
    limit?: number;              // Max rows to return (default: 1000)
    silent?: boolean;            // If true, don't send result back to UI
    requestId?: string;          // Optional correlation ID for silent query acknowledgements
  };
}

// Query result (Server -> Client)
export interface QueryResultMessage extends WSMessage {
  type: 'query_result';
  payload: {
    buildingId: string;
    result: QueryResult;
  };
}

// Silent query execution result (Server -> Client)
export interface SilentQueryResultMessage extends WSMessage {
  type: 'silent_query_result';
  payload: {
    buildingId: string;
    query: string;
    requestId?: string;
    success: boolean;
    affectedRows?: number;
    error?: string;
  };
}

// Query history update (Server -> Client)
export interface QueryHistoryUpdateMessage extends WSMessage {
  type: 'query_history_update';
  payload: {
    buildingId: string;
    history: QueryHistoryEntry[];
  };
}

// Request query history (Client -> Server)
export interface RequestQueryHistoryMessage extends WSMessage {
  type: 'request_query_history';
  payload: {
    buildingId: string;
    limit?: number;              // Max entries to return (default: 100)
  };
}

// Toggle query favorite (Client -> Server)
export interface ToggleQueryFavoriteMessage extends WSMessage {
  type: 'toggle_query_favorite';
  payload: {
    buildingId: string;
    queryId: string;
  };
}

// Delete query from history (Client -> Server)
export interface DeleteQueryHistoryMessage extends WSMessage {
  type: 'delete_query_history';
  payload: {
    buildingId: string;
    queryId: string;
  };
}

// Clear all query history (Client -> Server)
export interface ClearQueryHistoryMessage extends WSMessage {
  type: 'clear_query_history';
  payload: {
    buildingId: string;
  };
}

// Get table schema (Client -> Server)
export interface GetTableSchemaMessage extends WSMessage {
  type: 'get_table_schema';
  payload: {
    buildingId: string;
    connectionId: string;
    database: string;
    table: string;
  };
}

// Table schema result (Server -> Client)
export interface TableSchemaMessage extends WSMessage {
  type: 'table_schema';
  payload: {
    buildingId: string;
    connectionId: string;
    database: string;
    table: string;
    columns: TableColumn[];
    indexes?: TableIndex[];
    foreignKeys?: ForeignKey[];
  };
}

// List tables in database (Client -> Server)
export interface ListTablesMessage extends WSMessage {
  type: 'list_tables';
  payload: {
    buildingId: string;
    connectionId: string;
    database: string;
  };
}

// Tables list result (Server -> Client)
export interface TablesListMessage extends WSMessage {
  type: 'tables_list';
  payload: {
    buildingId: string;
    connectionId: string;
    database: string;
    tables: TableInfo[];
  };
}

// ============================================================================
// Trigger Messages
// ============================================================================
