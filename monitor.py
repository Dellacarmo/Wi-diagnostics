#!/usr/bin/env python3
"""
RF Space Observatory — Entry Point
Delegates to the Python backend package.

Usage:
    python monitor.py [options]

This is the root entry point that launches the full observatory.
For direct access, use: python python/monitor.py [options]
"""

import sys
import os

# Add the python package to path
python_dir = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'python')
sys.path.insert(0, python_dir)

# Import and run the main orchestrator
from monitor import main

if __name__ == "__main__":
    main()