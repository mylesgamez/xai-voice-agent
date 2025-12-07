import { searchNewsTopic, getTrendingNews } from './x-api';
import log from './logger';

export type ToolName = 'search_news_topic' | 'get_trending_news';

interface SearchNewsTopicArgs {
  topic: string;
}

interface GetTrendingNewsArgs {
  country?: string;
}

type ToolCallArgs = SearchNewsTopicArgs | GetTrendingNewsArgs;

/**
 * Execute a tool call and return the result
 */
export async function executeToolCall(
  callId: string,
  toolName: ToolName,
  args: ToolCallArgs
): Promise<string> {
  log.app.info(`[${callId}] 🔧 Executing tool: ${toolName}`);
  log.app.info(`[${callId}]    Arguments: ${JSON.stringify(args)}`);

  try {
    let result: string;

    switch (toolName) {
      case 'search_news_topic':
        const searchArgs = args as SearchNewsTopicArgs;
        result = await searchNewsTopic(searchArgs.topic);
        break;

      case 'get_trending_news':
        const trendArgs = args as GetTrendingNewsArgs;
        result = await getTrendingNews(trendArgs.country || 'US');
        break;

      default:
        result = JSON.stringify({ error: `Unknown tool: ${toolName}` });
    }

    log.app.info(`[${callId}] ✅ Tool completed: ${toolName}`);

    // Log a preview of the result (first 200 chars)
    const preview = result.length > 200 ? result.substring(0, 200) + '...' : result;
    log.app.info(`[${callId}]    Result preview: ${preview}`);

    return result;
  } catch (error) {
    log.app.error(`[${callId}] ❌ Tool failed: ${toolName}`, error);
    return JSON.stringify({
      success: false,
      error: `Tool execution failed: ${error}`
    });
  }
}
