import logging
import requests
import datetime

class MCPHandler(logging.Handler):
    def __init__(self, url="http://localhost:3030/logs", source="python-ml"):
        super().__init__()
        self.url = url
        self.source = source

    def emit(self, record):
        try:
            requests.post(self.url, json={
                "source": self.source,
                "level": record.levelname.lower(),
                "message": self.format(record),
                "timestamp": datetime.datetime.fromtimestamp(record.created).isoformat() + "Z"
            }, timeout=1)
        except Exception:
            pass  # Never crash the training loop if MCP server is down

def setup_mcp_logging():
    logger = logging.getLogger()
    logger.setLevel(logging.INFO)
    
    # Add MCP HTTP Handler
    mcp_handler = MCPHandler()
    formatter = logging.Formatter('%(message)s')
    mcp_handler.setFormatter(formatter)
    
    # Add standard stdout handler too
    console = logging.StreamHandler()
    console.setFormatter(formatter)
    
    logger.addHandler(mcp_handler)
    logger.addHandler(console)
    
    logging.info("Python MCP Logger initialized.")

# Call setup_mcp_logging() at the top of train.py
