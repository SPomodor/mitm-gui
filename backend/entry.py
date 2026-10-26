import multiprocessing

if __name__ == '__main__':
    multiprocessing.freeze_support()
    from backend.__main__ import main
    main()
