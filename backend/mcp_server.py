from fastmcp import FastMCP
from sympy import sympify
import asyncio

mcp = FastMCP('my local tools')

@mcp.tool()
def search_web(query: str, limit: int) -> list[str]:
    web_results = ["Test web result 1 is code 1426!", "Test web result number 2 is kind of lame, nobody really cares about it lol"]
    return web_results

@mcp.tool()
def evaluate(equation: str) -> str:
    "Calculates the resulting value of a mathematical equation."
    result = sympify(equation).evalf()
    return result


TYPE_MAP = {
    "str": "string",
    "int": "integer",
    "float": "number",
    "bool": "boolean",
}

async def initialize_tools():
    tools_list = []
    available_tools = {}
    for tool in await mcp.list_tools():
        tools_list.append({
            'type': 'function',
            'function': {
                'name': tool.name,
                'description': tool.description or f"Executes {tool.name}",
                'parameters': tool.parameters
            }
        })

    available_tools = {tool.name: tool.fn for tool in await mcp.list_tools()}
    return tools_list, available_tools


if __name__ == "__main__":
    mcp.run()